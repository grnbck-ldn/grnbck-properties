import { jsPDF } from "jspdf";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { PropertyRow } from "./types";
import {
  calcNetYield,
  calcGrossIrr,
  calcTotalReturnOnEquity,
  calcStampDuty,
  fmtGBP,
  fmtPct,
} from "./finance";
import { supabase } from "./supabase";

const BUCKET = "property-files";

// ── Colour palette ──────────────────────────────────────────────
const GREEN     = [0, 53, 47]    as const;  // #00352F  logo background
const DARK      = [17, 24, 39]   as const;  // #111827  headings
const LABEL_CLR = [107, 114, 128] as const; // #6B7280  labels
const LINE      = [229, 231, 235] as const; // #E5E7EB  dividers
const CARD_BG   = [249, 250, 251] as const; // #F9FAFB  card fill
const WHITE     = [255, 255, 255] as const;

// ── Layout constants (A4 = 210 × 297 mm) ───────────────────────
const ML = 18;
const PW = 210;
const CW = PW - ML * 2;
const R  = PW - ML;

// ── Logo cache ──────────────────────────────────────────────────
let _logo: string | null = null;
async function getLogo(): Promise<string | null> {
  if (_logo) return _logo;
  for (const path of ["/logo.png", "/icons/128x128.png", "/src-tauri/icons/128x128.png"]) {
    try {
      const r = await fetch(path);
      if (!r.ok) continue;
      const blob = await r.blob();
      _logo = await new Promise<string | null>((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result as string);
        fr.onerror = () => res(null);
        fr.readAsDataURL(blob);
      });
      if (_logo) return _logo;
    } catch { /* try next */ }
  }
  return null;
}

async function loadImg(url: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    const b = await r.blob();
    return new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result as string);
      fr.onerror = () => res(null);
      fr.readAsDataURL(b);
    });
  } catch { return null; }
}

// ── Drawing helpers ─────────────────────────────────────────────

function card(doc: jsPDF, x: number, y: number, w: number, h: number) {
  doc.setFillColor(...CARD_BG);
  doc.roundedRect(x, y, w, h, 2.5, 2.5, "F");
  doc.setDrawColor(...LINE);
  doc.setLineWidth(0.25);
  doc.roundedRect(x, y, w, h, 2.5, 2.5, "S");
}

/** Section heading with green accent bar — x-aware for cards */
function section(doc: jsPDF, title: string, x: number, y: number): number {
  doc.setFillColor(...GREEN);
  doc.rect(x, y - 3.5, 2.5, 5, "F");

  doc.setFontSize(10.5);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...DARK);
  doc.text(title.toUpperCase(), x + 6, y);
  return y + 8;
}

/** Key-value row inside a card — label left, value at valX */
function row(doc: jsPDF, lbl: string, val: string, x: number, y: number, valX: number): number {
  doc.setFontSize(8.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...LABEL_CLR);
  doc.text(lbl, x, y);

  doc.setFont("helvetica", "bold");
  doc.setTextColor(...DARK);
  doc.text(val, valX, y);
  return y + 5;
}

/** KPI metric card */
function kpi(doc: jsPDF, label: string, value: string, x: number, y: number, w: number) {
  card(doc, x, y, w, 22);
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...LABEL_CLR);
  doc.text(label, x + 5, y + 7);

  doc.setFontSize(15);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...GREEN);
  doc.text(value, x + 5, y + 17);
}

function pageBreak(doc: jsPDF, y: number, need: number, logo: string | null): number {
  if (y + need > 275) {
    doc.addPage();
    drawHeaderBar(doc, logo);
    return 28;
  }
  return y;
}

// ── Header & Footer ─────────────────────────────────────────────

function drawHeaderBar(doc: jsPDF, logo: string | null) {
  // Dark green header band
  doc.setFillColor(...GREEN);
  doc.rect(0, 0, PW, 22, "F");

  // Logo on green band — white text is now visible
  if (logo) {
    try {
      doc.addImage(logo, "PNG", ML, 1, 20, 20);
    } catch { /* skip */ }
  }

  // (logo already contains the grnbck text)

  // Right side
  doc.setFontSize(7.5);
  doc.setTextColor(200, 230, 215);
  doc.text("Property Investment Analysis", R, 12, { align: "right" });
  doc.text(new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), R, 17, { align: "right" });
}

function drawFooter(doc: jsPDF, pg: number, total: number) {
  const h = doc.internal.pageSize.getHeight();
  doc.setFillColor(...CARD_BG);
  doc.rect(0, h - 12, PW, 12, "F");
  doc.setDrawColor(...LINE);
  doc.setLineWidth(0.3);
  doc.line(ML, h - 12, R, h - 12);

  doc.setFontSize(6.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...LABEL_CLR);
  doc.text("grnbck London  \u2022  Property Investment Analysis  \u2022  Confidential", ML, h - 5.5);
  doc.text(`Page ${pg} of ${total}`, R, h - 5.5, { align: "right" });
}

// ════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ════════════════════════════════════════════════════════════════

export async function exportPropertyPdf(p: PropertyRow, addedBy?: string) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const logo = await getLogo();

  // ── Compute financials ────────────────────────────────────────
  const price = p.price_gbp ?? null;
  const fees = price != null ? price * (p.fees_pct ?? 0.01) : null;
  const stampDutyAuto = calcStampDuty(price, p.property_type);
  const stampDuty = p.stamp_duty_gbp ?? stampDutyAuto;
  const refurb = p.refurbishment_gbp ?? null;
  const annualRent = p.annual_rent_gbp;
  const resRent = p.annual_rent_residential_gbp;
  const comRent = p.annual_rent_commercial_gbp;

  const yieldPct = calcNetYield({ sqm: p.sqm, annualRent, opexPerSqm: p.opex_per_sqm_gbp_per_year, price, fees, stampDuty, refurbishment: refurb });
  const grossIrr = calcGrossIrr({ price, annualRent, sqm: p.sqm, opexPerSqm: p.opex_per_sqm_gbp_per_year, fees, stampDuty, refurbishment: refurb, ltvPct: p.ltv_pct, interestRatePct: p.interest_rate_pct, holdYears: p.hold_period_years, rentGrowthPct: p.rent_growth_pct, valueGrowthPct: p.value_growth_pct });
  const roe = calcTotalReturnOnEquity({ price, fees, stampDuty, refurbishment: refurb, annualRent, sqm: p.sqm, opexPerSqm: p.opex_per_sqm_gbp_per_year, ltvPct: p.ltv_pct, interestRatePct: p.interest_rate_pct, valueGrowthPct: p.value_growth_pct });
  const equity = price != null ? price * (1 - (p.ltv_pct ?? 0) / 100) + (fees ?? 0) + (stampDuty ?? 0) + (refurb ?? 0) : null;

  // ════════════════════════════════════════════════════════════════
  // PAGE 1
  // ════════════════════════════════════════════════════════════════
  drawHeaderBar(doc, logo);

  let y = 30;

  // ── Property Title ────────────────────────────────────────────
  doc.setFontSize(22);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...DARK);
  doc.text(p.address, ML, y);
  y += 7;

  if (p.borough || p.area) {
    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...LABEL_CLR);
    doc.text([p.borough, p.area].filter(Boolean).join("  \u2022  "), ML, y);
    y += 5;
  }

  if (p.listing_url) {
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(37, 99, 235);
    const u = p.listing_url.length > 85 ? p.listing_url.slice(0, 85) + "\u2026" : p.listing_url;
    doc.textWithLink(u, ML, y, { url: p.listing_url.startsWith("http") ? p.listing_url : `https://${p.listing_url}` });
    y += 4;
  }

  y += 5;

  // ── Hero KPI bar ──────────────────────────────────────────────
  const kpis = [
    { label: "Net Yield", value: fmtPct(yieldPct) },
    { label: "Return on Equity", value: fmtPct(roe) },
    { label: "Gross IRR", value: fmtPct(grossIrr) },
    { label: "Asking Price", value: fmtGBP(price) },
  ].filter(k => k.value);

  if (kpis.length > 0) {
    const gap = 4;
    const kw = (CW - gap * (kpis.length - 1)) / kpis.length;
    kpis.forEach((k, i) => kpi(doc, k.label, k.value, ML + i * (kw + gap), y, kw));
    y += 28;
  }

  y += 4;

  // ── Two-column cards: Property Details + Financial Summary ────
  const colGap = 6;
  const colW = (CW - colGap) / 2;
  const colL = ML;
  const colR = ML + colW + colGap;
  const cardTop = y;

  // Count rows for dynamic card height
  let leftRows = 0;
  if (p.selling_agent) leftRows++;
  if (addedBy) leftRows++;
  leftRows++; // type
  if (p.in_spv != null) leftRows++;
  if (p.sqm) leftRows++;

  let rightRows = 0;
  if (price != null) rightRows++;
  if (resRent != null && resRent > 0) rightRows++;
  if (comRent != null && comRent > 0) rightRows++;
  if (annualRent != null) rightRows++;
  if (p.opex_per_sqm_gbp_per_year != null && p.sqm != null) rightRows++;
  if (fees != null) rightRows++;
  if (stampDuty != null) rightRows++;
  if (refurb != null && refurb > 0) rightRows++;

  const cardH = Math.max(12 + leftRows * 5 + 4, 12 + rightRows * 5 + 4);

  // LEFT CARD
  card(doc, colL, cardTop, colW, cardH);
  let ly = section(doc, "Property Details", colL + 5, cardTop + 8);
  const lValX = colL + 38;
  if (p.selling_agent) ly = row(doc, "Agent", p.selling_agent, colL + 6, ly, lValX);
  if (addedBy) ly = row(doc, "Created by", addedBy, colL + 6, ly, lValX);
  ly = row(doc, "Type", p.property_type === "mixed_use" ? "Mixed-use" : "Residential", colL + 6, ly, lValX);
  if (p.in_spv != null) ly = row(doc, "SPV", p.in_spv ? "Yes" : "No", colL + 6, ly, lValX);
  if (p.sqm) ly = row(doc, "Size", `${p.sqm} m\u00B2`, colL + 6, ly, lValX);

  // RIGHT CARD
  card(doc, colR, cardTop, colW, cardH);
  let ry = section(doc, "Financial Summary", colR + 5, cardTop + 8);
  const rValX = colR + 42;
  if (price != null) ry = row(doc, "Asking price", fmtGBP(price), colR + 6, ry, rValX);
  if (resRent != null && resRent > 0) ry = row(doc, "Residential rent", fmtGBP(resRent), colR + 6, ry, rValX);
  if (comRent != null && comRent > 0) ry = row(doc, "Commercial rent", fmtGBP(comRent), colR + 6, ry, rValX);
  if (annualRent != null) ry = row(doc, "Total rent (p.a.)", fmtGBP(annualRent), colR + 6, ry, rValX);
  if (p.opex_per_sqm_gbp_per_year != null && p.sqm != null) {
    ry = row(doc, "Opex (p.a.)", fmtGBP(p.sqm * p.opex_per_sqm_gbp_per_year), colR + 6, ry, rValX);
  }
  if (fees != null) ry = row(doc, "Purchase fees", `${fmtGBP(fees)} (${((p.fees_pct ?? 0.01) * 100).toFixed(1)}%)`, colR + 6, ry, rValX);
  if (stampDuty != null) ry = row(doc, "Stamp duty", fmtGBP(stampDuty), colR + 6, ry, rValX);
  if (refurb != null && refurb > 0) ry = row(doc, "Refurbishment", fmtGBP(refurb), colR + 6, ry, rValX);

  y = cardTop + cardH + 6;

  // ── Investment Returns card (full width) ──────────────────────
  y = pageBreak(doc, y, 40, logo);

  const retItems: [string, string][] = [];
  if (yieldPct != null) retItems.push(["Net Yield", fmtPct(yieldPct)]);
  if (roe != null) retItems.push(["Return on Equity", fmtPct(roe)]);
  if (grossIrr != null) retItems.push(["Gross IRR", fmtPct(grossIrr)]);
  if (equity != null) retItems.push(["Total Equity In", fmtGBP(equity)]);
  if (p.ltv_pct != null) retItems.push(["LTV", `${p.ltv_pct}%`]);
  if (p.interest_rate_pct != null) retItems.push(["Interest Rate", `${p.interest_rate_pct}%`]);

  if (retItems.length > 0) {
    const retRows = Math.ceil(retItems.length / 2);
    const retH = 12 + retRows * 5.5 + 4;
    card(doc, ML, y, CW, retH);

    let iry = section(doc, "Investment Returns", ML + 5, y + 8);
    const halfW = CW / 2;

    retItems.forEach((item, i) => {
      const isRight = i % 2 === 1;
      const ix = isRight ? ML + halfW + 6 : ML + 6;
      const ivx = isRight ? ML + halfW + 48 : ML + 48;
      const rowY = iry + Math.floor(i / 2) * 5.5;
      row(doc, item[0], item[1], ix, rowY, ivx);
    });

    y += retH + 6;
  }

  // ── Assumptions card (full width) ─────────────────────────────
  {
    const hasAssumptions = p.hold_period_years || p.rent_growth_pct || p.value_growth_pct || p.opex_per_sqm_gbp_per_year != null;
    if (hasAssumptions) {
      y = pageBreak(doc, y, 35, logo);

      let aRows = 0;
      if (p.opex_per_sqm_gbp_per_year != null) aRows++;
      if (p.hold_period_years) aRows++;
      if (p.rent_growth_pct != null) aRows++;
      if (p.value_growth_pct != null) aRows++;
      const aH = 12 + aRows * 5 + 4;

      card(doc, ML, y, CW, aH);
      let ay = section(doc, "Assumptions", ML + 5, y + 8);
      if (p.opex_per_sqm_gbp_per_year != null) ay = row(doc, "Opex per m\u00B2/year", fmtGBP(p.opex_per_sqm_gbp_per_year), ML + 6, ay, ML + 48);
      if (p.hold_period_years) ay = row(doc, "Hold period", `${p.hold_period_years} years`, ML + 6, ay, ML + 48);
      if (p.rent_growth_pct != null) ay = row(doc, "Annual rent growth", `${p.rent_growth_pct}%`, ML + 6, ay, ML + 48);
      if (p.value_growth_pct != null) ay = row(doc, "Annual value growth", `${p.value_growth_pct}%`, ML + 6, ay, ML + 48);

      y += aH + 6;
    }
  }

  // ── Photos ────────────────────────────────────────────────────
  const { data: fileList } = await supabase.storage.from(BUCKET).list(p.id);
  const imageFiles = (fileList ?? [])
    .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f.name) && f.name !== ".emptyFolderPlaceholder")
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));

  if (imageFiles.length > 0) {
    y = pageBreak(doc, y, 80, logo);
    y = section(doc, "Photos", ML, y) + 2;

    let imgX = ML;
    const gap = 5;
    const imgW = (CW - gap) / 2;
    const imgH = imgW * 0.65;

    for (const f of imageFiles.slice(0, 6)) {
      const path = `${p.id}/${f.name}`;
      const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(path);
      const dataUrl = await loadImg(urlData.publicUrl);
      if (!dataUrl) continue;

      y = pageBreak(doc, y, imgH + 8, logo);

      try {
        doc.addImage(dataUrl, "JPEG", imgX, y, imgW, imgH);
        if (imgX === ML) {
          imgX = ML + imgW + gap;
        } else {
          imgX = ML;
          y += imgH + gap;
        }
      } catch { /* skip */ }
    }
    if (imgX !== ML) y += imgH + gap;
  }

  // ── Footers on every page ─────────────────────────────────────
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    drawFooter(doc, i, total);
  }

  // ── Save ──────────────────────────────────────────────────────
  const safeName = p.address.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "_");
  const filePath = await save({
    defaultPath: `${safeName}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!filePath) return;

  const arrayBuf = doc.output("arraybuffer");
  await writeFile(filePath, new Uint8Array(arrayBuf));
}
