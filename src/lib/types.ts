export type PropertyType = "residential" | "mixed_use";

export type PropertyRow = {
  id: string;
  org_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;

  address: string;
  borough: string | null;
  area: string | null;
  selling_agent: string | null;
  listing_url: string | null;

  // tri-state SPV (Yes/No/Don't know)
  in_spv: boolean | null;

  sqm: number | null;
  price_gbp: number | null;

  // keep this if you still store it in DB (legacy)
  taxes_and_fees_gbp: number | null;

  opex_per_sqm_gbp_per_year: number | null;
  annual_rent_gbp: number | null;

  // NEW fields for fees / SDLT / IRR model
  property_type: PropertyType;      // "residential" | "mixed_use"
  fees_pct: number;                // decimal, e.g. 0.01 = 1%
  stamp_duty_gbp: number | null;   // allow override or stored calc

  ltv_pct: number | null;           // e.g. 60 means 60%
  interest_rate_pct: number | null; // e.g. 6 means 6%
  hold_period_years: number | null; // e.g. 5
  rent_growth_pct: number | null;   // e.g. 3 means 3%
  value_growth_pct: number | null;  // e.g. 3 means 3%
};

export type ProfileRow = {
  id: string;
  org_id: string;
  role: string;
};