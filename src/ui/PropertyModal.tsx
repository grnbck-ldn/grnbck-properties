import React, { useMemo, useState } from "react";
import { PropertyRow } from "../lib/types";
import { calcNetYield, fmtGBP, fmtPct, calcStampDuty, calcGrossIrr } from "../lib/finance";

type Props = {
  title: string;
  initial?: PropertyRow;
  onClose: () => void;
  onSave: (payload: Partial<PropertyRow> & { id?: string }) => Promise<void>;
};

function numOrNull(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function PropertyModal({ title, initial, onClose, onSave }: Props) {
  const [saving, setSaving] = useState(false);

  // Basic info
  const [address, setAddress] = useState(initial?.address ?? "");
  const [borough, setBorough] = useState(initial?.borough ?? "");
  const [area, setArea] = useState(initial?.area ?? "");
  const [sellingAgent, setSellingAgent] = useState(initial?.selling_agent ?? "");
  const [listingUrl, setListingUrl] = useState(initial?.listing_url ?? "");

  // Tri-state SPV
  const [inSpv, setInSpv] = useState<boolean | null>(initial?.in_spv ?? null);

  // Core numbers
  const [sqm, setSqm] = useState(initial?.sqm?.toString() ?? "");
  const [price, setPrice] = useState(initial?.price_gbp?.toString() ?? "");
  const [opexPerSqm, setOpexPerSqm] = useState(initial?.opex_per_sqm_gbp_per_year?.toString() ?? "");
  const [annualRent, setAnnualRent] = useState(initial?.annual_rent_gbp?.toString() ?? "");

  // New: property type + fees + stamp duty
  const [propertyType, setPropertyType] = useState<"residential" | "mixed_use">(
    (initial as any)?.property_type ?? "residential"
  );

  // UI stores fees as %, DB stores decimal (0.01 = 1%)
  const [feesPct, setFeesPct] = useState<number>(((initial as any)?.fees_pct ?? 0.01) * 100);

  // stamp duty is auto unless override typed
  const [stampDutyOverride, setStampDutyOverride] = useState<string>(
    (initial as any)?.stamp_duty_gbp != null ? String((initial as any).stamp_duty_gbp) : ""
  );

  // Project assumptions
  const [ltvPct, setLtvPct] = useState((initial as any)?.ltv_pct?.toString() ?? "60");
  const [interestRatePct, setInterestRatePct] = useState((initial as any)?.interest_rate_pct?.toString() ?? "6");
  const [holdYears, setHoldYears] = useState((initial as any)?.hold_period_years?.toString() ?? "5");
  const [rentGrowthPct, setRentGrowthPct] = useState((initial as any)?.rent_growth_pct?.toString() ?? "0");
  const [valueGrowthPct, setValueGrowthPct] = useState((initial as any)?.value_growth_pct?.toString() ?? "0");

  const priceNum = useMemo(() => numOrNull(price), [price]);

  const feesGbp = useMemo(() => {
    if (priceNum == null) return null;
    const pct = Number.isFinite(feesPct) ? feesPct / 100 : 0.01;
    return priceNum * pct;
  }, [priceNum, feesPct]);

  const stampDutyAuto = useMemo(() => calcStampDuty(priceNum, propertyType), [priceNum, propertyType]);

  const stampDutyGbp = useMemo(() => {
    const override = numOrNull(stampDutyOverride);
    return override ?? stampDutyAuto;
  }, [stampDutyOverride, stampDutyAuto]);

  const yieldPct = useMemo(() => {
    return calcNetYield({
      sqm: numOrNull(sqm),
      annualRent: numOrNull(annualRent),
      opexPerSqm: numOrNull(opexPerSqm),
      price: priceNum,
      fees: feesGbp,
      stampDuty: stampDutyGbp,
    });
  }, [sqm, annualRent, opexPerSqm, priceNum, feesGbp, stampDutyGbp]);

  const grossIrr = useMemo(() => {
    return calcGrossIrr({
      price: priceNum,
      annualRent: numOrNull(annualRent),
      sqm: numOrNull(sqm),
      opexPerSqm: numOrNull(opexPerSqm),
      fees: feesGbp,
      stampDuty: stampDutyGbp,
      ltvPct: numOrNull(ltvPct),
      interestRatePct: numOrNull(interestRatePct),
      holdYears: numOrNull(holdYears),
      rentGrowthPct: numOrNull(rentGrowthPct),
      valueGrowthPct: numOrNull(valueGrowthPct),
    });
  }, [
    priceNum,
    annualRent,
    sqm,
    opexPerSqm,
    feesGbp,
    stampDutyGbp,
    ltvPct,
    interestRatePct,
    holdYears,
    rentGrowthPct,
    valueGrowthPct,
  ]);

  async function submit() {
    if (!address.trim()) {
      alert("Address is required.");
      return;
    }

    setSaving(true);
    try {
      const feesPctDecimal = Number.isFinite(feesPct) ? feesPct / 100 : 0.01;

      await onSave({
        id: initial?.id,
        address: address.trim(),
        borough: borough.trim() || null,
        area: area.trim() || null,
        selling_agent: sellingAgent.trim() || null,
        listing_url: listingUrl.trim() || null,

        in_spv: inSpv,

        sqm: numOrNull(sqm),
        price_gbp: priceNum,
        opex_per_sqm_gbp_per_year: numOrNull(opexPerSqm),
        annual_rent_gbp: numOrNull(annualRent),

        // NEW fields
        property_type: propertyType,
        fees_pct: feesPctDecimal,
        stamp_duty_gbp: stampDutyGbp,

        ltv_pct: numOrNull(ltvPct),
        interest_rate_pct: numOrNull(interestRatePct),
        hold_period_years: numOrNull(holdYears),
        rent_growth_pct: numOrNull(rentGrowthPct),
        value_growth_pct: numOrNull(valueGrowthPct),
      } as any);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modalBackdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 8 }}>
          <h2>{title}</h2>
          <button className="secondary" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="grid2">
          <div className="field">
            <label>Address *</label>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="10 Example Street, London"
            />
          </div>

          <div className="field">
            <label>Listing URL</label>
            <input value={listingUrl} onChange={(e) => setListingUrl(e.target.value)} placeholder="https://..." />
          </div>

          <div className="field">
            <label>Borough</label>
            <input value={borough} onChange={(e) => setBorough(e.target.value)} placeholder="Southwark" />
          </div>

          <div className="field">
            <label>Area</label>
            <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="Bermondsey" />
          </div>

          <div className="field">
            <label>Selling agent</label>
            <input value={sellingAgent} onChange={(e) => setSellingAgent(e.target.value)} placeholder="Savills" />
          </div>

          <div className="field">
            <label>Held in SPV?</label>
            <select
              value={inSpv === null ? "unknown" : inSpv ? "yes" : "no"}
              onChange={(e) => {
                const v = e.target.value;
                setInSpv(v === "yes" ? true : v === "no" ? false : null);
              }}
            >
              <option value="unknown">Don’t know</option>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </div>

          <div className="field">
            <label>Property type</label>
            <select value={propertyType} onChange={(e) => setPropertyType(e.target.value as any)}>
              <option value="residential">Residential</option>
              <option value="mixed_use">Mixed-use</option>
            </select>
          </div>

          <div className="field">
            <label>Fees (% of purchase)</label>
            <input value={String(feesPct)} onChange={(e) => setFeesPct(Number(e.target.value))} inputMode="decimal" />
            <div className="small">Fees (£): {fmtGBP(feesGbp)}</div>
          </div>

          <div className="field">
            <label>Stamp Duty (£)</label>
            <input
              value={stampDutyOverride}
              onChange={(e) => setStampDutyOverride(e.target.value)}
              placeholder={stampDutyAuto != null ? String(Math.round(stampDutyAuto)) : ""}
              inputMode="decimal"
            />
            <div className="small">
              Auto: {stampDutyAuto != null ? fmtGBP(stampDutyAuto) : "—"} (leave blank to use auto)
            </div>
          </div>
        </div>

        <div className="grid3" style={{ marginTop: 12 }}>
          <div className="field">
            <label>Size (m²)</label>
            <input value={sqm} onChange={(e) => setSqm(e.target.value)} inputMode="decimal" />
          </div>

          <div className="field">
            <label>Price (£)</label>
            <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
          </div>

          <div className="field">
            <label>Opex (£/m²/year)</label>
            <input value={opexPerSqm} onChange={(e) => setOpexPerSqm(e.target.value)} inputMode="decimal" />
          </div>

          <div className="field">
            <label>Annual rent (£)</label>
            <input value={annualRent} onChange={(e) => setAnnualRent(e.target.value)} inputMode="decimal" />
          </div>

          <div className="field">
            <label>Net yield (calc)</label>
            <input value={fmtPct(yieldPct)} readOnly />
          </div>

          <div className="field">
            <label>Gross IRR (calc)</label>
            <input value={fmtPct(grossIrr)} readOnly />
          </div>
        </div>

        <div className="grid3" style={{ marginTop: 12 }}>
          <div className="field">
            <label>LTV (%)</label>
            <input value={ltvPct} onChange={(e) => setLtvPct(e.target.value)} inputMode="decimal" />
          </div>

          <div className="field">
            <label>Interest rate (%)</label>
            <input
              value={interestRatePct}
              onChange={(e) => setInterestRatePct(e.target.value)}
              inputMode="decimal"
            />
          </div>

          <div className="field">
            <label>Hold period (years)</label>
            <input value={holdYears} onChange={(e) => setHoldYears(e.target.value)} inputMode="decimal" />
          </div>

          <div className="field">
            <label>Annual rent increase (%)</label>
            <input value={rentGrowthPct} onChange={(e) => setRentGrowthPct(e.target.value)} inputMode="decimal" />
          </div>

          <div className="field">
            <label>Annual property value increase (%)</label>
            <input value={valueGrowthPct} onChange={(e) => setValueGrowthPct(e.target.value)} inputMode="decimal" />
          </div>
        </div>

        <div className="row end" style={{ marginTop: 14 }}>
          <button className="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}