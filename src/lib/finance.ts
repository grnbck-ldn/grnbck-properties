export function calcNetYield(params: {
  sqm: number | null;
  annualRent: number | null;
  opexPerSqm: number | null;
  price: number | null;
  fees: number | null;
  stampDuty: number | null;
}): number | null {
  const { sqm, annualRent, opexPerSqm, price, fees, stampDuty } = params;

  if (price == null || annualRent == null || !Number.isFinite(price) || price <= 0) return null;

  const opex =
    sqm != null && opexPerSqm != null && Number.isFinite(sqm) && Number.isFinite(opexPerSqm)
      ? opexPerSqm * sqm
      : 0;

  const net = annualRent - opex;

  const denom = price + (fees ?? 0) + (stampDuty ?? 0);
  if (!Number.isFinite(denom) || denom <= 0) return null;

  return net / denom;
}

export function fmtGBP(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(n);
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "";
  return new Intl.NumberFormat("en-GB", {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(n);
}

export type PropertyType = "residential" | "mixed_use" | "residential_6plus";

function slab(price: number, bands: Array<{ upTo: number | null; rate: number }>) {
  let remaining = price;
  let lastCap = 0;
  let total = 0;

  for (const b of bands) {
    const cap = b.upTo ?? Infinity;
    const width = Math.max(0, Math.min(remaining, cap - lastCap));
    if (width <= 0) break;

    total += width * b.rate;
    remaining -= width;
    lastCap = cap;
  }

  return total;
}

export function calcStampDuty(price: number | null, type: PropertyType): number | null {
  if (price == null || !Number.isFinite(price) || price <= 0) return null;

  if (type === "mixed_use" || type === "residential_6plus") {
    // Up to 150k: 0%, 150–250k: 2%, 250k+: 5%
    return slab(price, [
      { upTo: 150_000, rate: 0.0 },
      { upTo: 250_000, rate: 0.02 },
      { upTo: null, rate: 0.05 },
    ]);
  }

  // Residential (your bands)
  return slab(price, [
    { upTo: 125_000, rate: 0.05 },
    { upTo: 250_000, rate: 0.07 },
    { upTo: 925_000, rate: 0.10 },
    { upTo: 1_500_000, rate: 0.15 },
    { upTo: null, rate: 0.17 },
  ]);
}

function npv(rate: number, cashFlows: number[]) {
  let s = 0;
  for (let t = 0; t < cashFlows.length; t++) {
    s += cashFlows[t] / Math.pow(1 + rate, t);
  }
  return s;
}

export function irr(cashFlows: number[]): number | null {
  const hasNeg = cashFlows.some((x) => x < 0);
  const hasPos = cashFlows.some((x) => x > 0);
  if (!hasNeg || !hasPos) return null;

  let lo = -0.9;
  let hi = 5.0;

  let fLo = npv(lo, cashFlows);
  let fHi = npv(hi, cashFlows);

  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) return null;
  if (fLo * fHi > 0) return null; // no bracket

  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid, cashFlows);

    if (!Number.isFinite(fMid)) return null;
    if (Math.abs(fMid) < 1e-7) return mid;

    // Maintain the bracket [lo, hi] such that f(lo) and f(hi) have opposite signs
    if (fLo * fMid <= 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }

  return (lo + hi) / 2;
}

export function calcGrossIrr(args: {
  price: number | null;
  annualRent: number | null;
  sqm: number | null;
  opexPerSqm: number | null;

  fees: number | null;
  stampDuty: number | null;

  ltvPct: number | null;
  interestRatePct: number | null;
  holdYears: number | null;
  rentGrowthPct: number | null;
  valueGrowthPct: number | null;
}): number | null {
  const {
    price,
    annualRent,
    sqm,
    opexPerSqm,
    fees,
    stampDuty,
    ltvPct,
    interestRatePct,
    holdYears,
    rentGrowthPct,
    valueGrowthPct,
  } = args;

  if (price == null || annualRent == null || holdYears == null) return null;
  if (!Number.isFinite(price) || !Number.isFinite(annualRent) || !Number.isFinite(holdYears)) return null;
  if (price <= 0 || annualRent < 0 || holdYears <= 0) return null;

  const ltv = Math.max(0, Math.min(1, (ltvPct ?? 0) / 100));
  const i = (interestRatePct ?? 0) / 100;
  const gRent = (rentGrowthPct ?? 0) / 100;
  const gVal = (valueGrowthPct ?? 0) / 100;

  const debt = price * ltv;
  const equityOut = price * (1 - ltv) + (fees ?? 0) + (stampDuty ?? 0);

  const opex0 =
    sqm != null && opexPerSqm != null && Number.isFinite(sqm) && Number.isFinite(opexPerSqm)
      ? sqm * opexPerSqm
      : 0;

  const interestOnly = debt * i;

  const cashFlows: number[] = [];
  cashFlows.push(-equityOut);

  for (let y = 1; y <= holdYears; y++) {
    const rentY = annualRent * Math.pow(1 + gRent, y - 1);
    const netY = rentY - opex0 - interestOnly;
    cashFlows.push(netY);
  }

  const sale = price * Math.pow(1 + gVal, holdYears);
  cashFlows[cashFlows.length - 1] += sale - debt; // repay principal at exit

  return irr(cashFlows);
}

export function calcTotalReturnOnEquity(args: {
  price: number | null;
  fees: number | null;
  stampDuty: number | null;
  annualRent: number | null;
  sqm: number | null;
  opexPerSqm: number | null;
  ltvPct: number | null;
  interestRatePct: number | null;
  valueGrowthPct: number | null;
}): number | null {
  const {
    price,
    fees,
    stampDuty,
    annualRent,
    sqm,
    opexPerSqm,
    ltvPct,
    interestRatePct,
    valueGrowthPct,
  } = args;

  if (price == null || annualRent == null) return null;
  if (!Number.isFinite(price) || !Number.isFinite(annualRent)) return null;
  if (price <= 0 || annualRent < 0) return null;

  const ltv = (ltvPct ?? 0) / 100;
  const interestRate = (interestRatePct ?? 0) / 100;
  const growthRate = (valueGrowthPct ?? 0) / 100;

  // Calculate total investment and equity
  const totalInvestment = price + (fees ?? 0) + (stampDuty ?? 0);
  const debt = price * ltv;
  const equity = totalInvestment - debt;

  if (equity <= 0) return null;

  // Calculate NOI (Net Operating Income)
  const opex = sqm != null && opexPerSqm != null && Number.isFinite(sqm) && Number.isFinite(opexPerSqm)
    ? sqm * opexPerSqm
    : 0;
  const noi = annualRent - opex;

  // Calculate yield on equity (cash flow after interest)
  const interestPayment = debt * interestRate;
  const netCashFlow = noi - interestPayment;
  const yieldOnEquity = netCashFlow / equity;

  // Calculate growth return on equity
  const propertyGrowthReturn = (price * growthRate) / equity;

  // Total return on equity = yield on equity + growth return
  return yieldOnEquity + propertyGrowthReturn;
}