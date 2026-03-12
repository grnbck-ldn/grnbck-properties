import React, { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { check } from "@tauri-apps/plugin-updater";
import { supabase } from "../lib/supabase";
import { PropertyRow, ProfileRow } from "../lib/types";
import { calcGrossIrr, calcNetYield, calcTotalReturnOnEquity, fmtGBP, fmtPct } from "../lib/finance";
import { PropertyModal } from "./PropertyModal";
import { PropertyMap } from "./PropertyMap";
import { PropertyFinder } from "./PropertyFinder";
import { PropertyFiles } from "./PropertyFiles";


type SortKey =
  | "updated_at"
  | "address"
  | "borough"
  | "price_gbp"
  | "annual_rent_gbp"
  | "ltv_pct"
  | "interest_rate_pct";

export function App() {
  const [session, setSession] = useState<
    Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]
  >(null);
  const [profile, setProfile] = useState<ProfileRow | null>(null);

  const [properties, setProperties] = useState<PropertyRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("updated_at");
  const [sortDesc, setSortDesc] = useState(true);

  const [editing, setEditing] = useState<PropertyRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"table" | "map" | "finder">("table");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) =>
      setSession(s)
    );
    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    check()
      .then(async (update) => {
        if (update) {
          let downloaded = 0;
          let total = 0;
          await update.downloadAndInstall((event) => {
            if (event.event === "Started") {
              total = event.data.contentLength ?? 0;
              setUpdateStatus(`Downloading v${update.version}…`);
            } else if (event.event === "Progress") {
              downloaded += event.data.chunkLength;
              if (total > 0) {
                const pct = Math.round((downloaded / total) * 100);
                setUpdateStatus(`Downloading v${update.version}… ${pct}%`);
              }
            } else if (event.event === "Finished") {
              setUpdateStatus("Update ready — close and reopen the app to apply.");
            }
          });
        }
      })
      .catch((e) => console.error("Update check failed:", e));
  }, []);

  async function loadProfileAndProperties() {
    setError(null);
    setLoading(true);
    try {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      if (!userId) return;

      const prof = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .maybeSingle();
      if (prof.error) throw prof.error;

      if (!prof.data) {
        setProfile(null);
        setProperties([]);
        return;
      }

      setProfile(prof.data as ProfileRow);

      const props = await supabase
        .from("properties")
        .select("*")
        .order(sortKey, { ascending: !sortDesc })
        .limit(500);

      if (props.error) throw props.error;
      setProperties((props.data ?? []) as PropertyRow[]);
    } catch (e: any) {
      setError(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (session) loadProfileAndProperties();
    else {
      setProfile(null);
      setProperties([]);
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sortKey, sortDesc]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return properties;
    return properties.filter((p) =>
      [p.address, p.borough ?? "", p.area ?? "", p.selling_agent ?? ""].some((v) =>
        v.toLowerCase().includes(q)
      )
    );
  }, [properties, search]);

  async function signIn() {
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
  }

  async function signUp() {
    setError(null);
    setSuccess(null);
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) setError(error.message);
    else setSuccess("Account created!");
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  async function upsertProperty(payload: Partial<PropertyRow> & { id?: string }) {
    if (!profile) throw new Error("Missing profile (ask admin to add you to profiles table).");

    const user = (await supabase.auth.getUser()).data.user;
    if (!user) throw new Error("Not signed in.");

    const row: any = {
      ...payload,
      org_id: profile.org_id,
      created_by: user.id,
    };

    if (payload.id) {
      const { error } = await supabase.from("properties").update(row).eq("id", payload.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("properties").insert(row);
      if (error) throw error;
    }

    await loadProfileAndProperties();
  }

  async function deleteProperty(id: string) {
    const ok = confirm("Delete this property record?");
    if (!ok) return;
    const { error } = await supabase.from("properties").delete().eq("id", id);
    if (error) setError(error.message);
    else await loadProfileAndProperties();
  }

  if (!session) {
    return (
      <div className="container">
        <div className="card" style={{ maxWidth: 520, margin: "60px auto" }}>
          <h1>grnbck Properties</h1>
          <p className="muted" style={{ marginTop: 8 }}>
            Sign in to access the shared property database.
          </p>

          <div className="field" style={{ marginTop: 14 }}>
            <label>Email</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@grnbck.com"
            />
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <p className="small" style={{ color: "#fb7185", marginTop: 12 }}>
              {error}
            </p>
          )}
          {success && (
            <p className="small" style={{ color: "#34d399", marginTop: 12 }}>
              {success}
            </p>
          )}

          <div className="row end" style={{ marginTop: 14 }}>
            <button className="secondary" onClick={signUp}>
              Create account
            </button>
            <button onClick={signIn}>Sign in</button>
          </div>

          <p className="small" style={{ marginTop: 12 }}>
            If you create an account, an admin must add your user ID to the{" "}
            <code>profiles</code> table with the grnbck <code>org_id</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      {updateStatus && (
        <div className="card" style={{ marginBottom: 12, padding: "10px 16px", background: "rgba(125,211,252,0.10)" }}>
          {updateStatus}
        </div>
      )}
      <div className="row between" style={{ marginBottom: 14 }}>
        <div>
          <h1>grnbck London <span className="small" style={{ color: 'var(--muted)', fontWeight: 'normal' }}>v1.1.0</span></h1>
          {!profile && (
            <div className="small">
              No org profile yet — ask admin to add you to <code>profiles</code>.
            </div>
          )}
        </div>
        <div className="row">
          <button className="secondary" onClick={() => loadProfileAndProperties()}>
            Refresh
          </button>
          <button className="secondary" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row between">
          <div className="row">
            <div className="row" style={{ background: "rgba(255,255,255,0.06)", borderRadius: 8, padding: 2 }}>
              <button
                className={viewMode === "table" ? "" : "secondary"}
                onClick={() => setViewMode("table")}
                style={{ fontSize: 12, padding: "6px 12px" }}
              >
                Portfolio
              </button>
              <button
                className={viewMode === "map" ? "" : "secondary"}
                onClick={() => setViewMode("map")}
                style={{ fontSize: 12, padding: "6px 12px" }}
              >
                Map
              </button>
              <button
                className={viewMode === "finder" ? "" : "secondary"}
                onClick={() => setViewMode("finder")}
                style={{ fontSize: 12, padding: "6px 12px" }}
              >
                Finder
              </button>
            </div>

            {viewMode === "table" && (
              <>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search address, borough, agent..."
                  style={{ width: 280, maxWidth: "50vw" }}
                />

                <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
                  <option value="updated_at">Sort: Last updated</option>
                  <option value="address">Sort: Address</option>
                  <option value="borough">Sort: Borough</option>
                  <option value="price_gbp">Sort: Price</option>
                  <option value="annual_rent_gbp">Sort: Rent</option>
                  <option value="ltv_pct">Sort: LTV</option>
                  <option value="interest_rate_pct">Sort: Interest rate</option>
                </select>

                <button className="secondary" onClick={() => setSortDesc((d) => !d)}>
                  {sortDesc ? "Desc" : "Asc"}
                </button>
              </>
            )}
          </div>

          <button onClick={() => setCreating(true)} disabled={!profile}>
            Add property
          </button>
        </div>

        {error && (
          <p className="small" style={{ color: "#fb7185", marginTop: 10 }}>
            {error}
          </p>
        )}

        {loading ? (
          <p className="muted" style={{ marginTop: 12 }}>
            Loading…
          </p>
        ) : viewMode === "map" ? (
          <div style={{ marginTop: 12 }}>
            <PropertyMap properties={filtered} />
          </div>
        ) : viewMode === "finder" ? (
          <div style={{ marginTop: 12 }}>
            <PropertyFinder
              onAddProperty={upsertProperty}
              existingUrls={new Set(properties.map(p => p.listing_url).filter(Boolean) as string[])}
            />
          </div>
        ) : (
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Borough / Area</th>
                  <th>ROE</th>
                  <th>Yield</th>
                  <th>Price</th>
                  <th>Annual rent</th>
                  <th>Size</th>
                  <th>Opex</th>
                  <th>LTV</th>
                  <th>Interest rate</th>
                  <th>Link</th>
                  <th>Details</th>
                  <th></th>
                </tr>
              </thead>

              <tbody>
                {filtered.map((p) => {
                  const price = p.price_gbp ?? null;

                  const fees = price != null ? price * (p.fees_pct ?? 0.01) : null;
                  const stampDuty = p.stamp_duty_gbp ?? null;

                  const yieldPct = calcNetYield({
                    sqm: p.sqm,
                    annualRent: p.annual_rent_gbp,
                    opexPerSqm: p.opex_per_sqm_gbp_per_year,
                    price,
                    fees,
                    stampDuty,
                  });

                  const grossIrr = calcGrossIrr({
                    price,
                    annualRent: p.annual_rent_gbp,
                    sqm: p.sqm,
                    opexPerSqm: p.opex_per_sqm_gbp_per_year,
                    fees,
                    stampDuty,
                    ltvPct: p.ltv_pct,
                    interestRatePct: p.interest_rate_pct,
                    holdYears: p.hold_period_years,
                    rentGrowthPct: p.rent_growth_pct,
                    valueGrowthPct: p.value_growth_pct,
                  });

                  const totalReturnOnEquity = calcTotalReturnOnEquity({
                    price,
                    fees,
                    stampDuty,
                    annualRent: p.annual_rent_gbp,
                    sqm: p.sqm,
                    opexPerSqm: p.opex_per_sqm_gbp_per_year,
                    ltvPct: p.ltv_pct,
                    interestRatePct: p.interest_rate_pct,
                    valueGrowthPct: p.value_growth_pct,
                  });

                  const opexTotal =
                    p.sqm != null && p.opex_per_sqm_gbp_per_year != null
                      ? p.sqm * p.opex_per_sqm_gbp_per_year
                      : null;

                  const isOpen = expanded === p.id;

                  return (
                    <React.Fragment key={p.id}>
                      <tr>
                        <td style={{ minWidth: 260 }}>
                          <div style={{ fontWeight: 600 }}>{p.address}</div>
                          <div className="small">Updated: {new Date(p.updated_at).toLocaleString("en-GB")}</div>
                          {p.selling_agent && <div className="small">Agent: {p.selling_agent}</div>}
                        </td>

                        <td style={{ minWidth: 170 }}>
                          <div>{p.borough ?? ""}</div>
                          <div className="small">{p.area ?? ""}</div>
                        </td>

                        <td style={{ fontWeight: 700 }}>{fmtPct(totalReturnOnEquity)}</td>
                        <td style={{ fontWeight: 700 }}>{fmtPct(yieldPct)}</td>
                        <td>{fmtGBP(price)}</td>
                        <td>{fmtGBP(p.annual_rent_gbp)}</td>
                        <td>{p.sqm != null ? `${p.sqm} m²` : ""}</td>

                        <td>
                          {p.opex_per_sqm_gbp_per_year != null ? (
                            <>
                              <div className="small">
                                {fmtGBP(p.opex_per_sqm_gbp_per_year)} / m² / yr
                              </div>
                              <div>{fmtGBP(opexTotal)}</div>
                            </>
                          ) : (
                            ""
                          )}
                        </td>

                        <td>{p.ltv_pct != null ? `${p.ltv_pct}%` : ""}</td>
                        <td>{p.interest_rate_pct != null ? `${p.interest_rate_pct}%` : ""}</td>

                        <td>
                          {p.listing_url ? (
                            <button
                              className="linkButton"
                              type="button"
                              onClick={async () => {
                                try {
                                  const url = p.listing_url!.startsWith("http")
                                    ? p.listing_url!
                                    : `https://${p.listing_url}`;
                                  await open(url);
                                } catch (e) {
                                  console.error("Failed to open url", e);
                                  alert("Could not open the link.");
                                }
                              }}
                            >
                              Listing
                            </button>
                          ) : (
                            ""
                          )}
                        </td>

                        <td>
                          <button
                            className="secondary"
                            type="button"
                            onClick={() => setExpanded(isOpen ? null : p.id)}
                          >
                            {isOpen ? "Hide" : "Details"}
                          </button>
                        </td>

                        <td className="row" style={{ gap: 8 }}>
                          <button className="secondary" onClick={() => setEditing(p)}>
                            Edit
                          </button>
                          <button className="danger" onClick={() => deleteProperty(p.id)}>
                            Delete
                          </button>
                        </td>
                      </tr>

                      {isOpen && (
                        <tr>
                          <td colSpan={13}>
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                                gap: "14px",
                                padding: "14px 0",
                              }}
                            >
                              <div>
                                <strong>Property type:</strong> {p.property_type}
                              </div>

                              <div>
                                <strong>SPV:</strong>{" "}
                                {p.in_spv === true ? "Yes" : p.in_spv === false ? "No" : "Don't know"}
                              </div>

                              <div>
                                <strong>Fees %:</strong>{" "}
                                {p.fees_pct != null ? `${(p.fees_pct * 100).toFixed(2)}%` : ""}
                              </div>

                              <div>
                                <strong>Fees £:</strong> {fmtGBP(fees)}
                              </div>

                              <div>
                                <strong>Stamp duty £:</strong> {fmtGBP(stampDuty)}
                              </div>

                              <div>
                                <strong>Hold period:</strong>{" "}
                                {p.hold_period_years != null ? `${p.hold_period_years} yrs` : ""}
                              </div>

                              <div>
                                <strong>Rent growth:</strong>{" "}
                                {p.rent_growth_pct != null ? `${p.rent_growth_pct}%` : ""}
                              </div>

                              <div>
                                <strong>Value growth:</strong>{" "}
                                {p.value_growth_pct != null ? `${p.value_growth_pct}%` : ""}
                              </div>

                              <div>
                                <strong>Gross IRR:</strong> {fmtPct(grossIrr)}
                              </div>

                              <div>
                                <strong>Total equity in:</strong>{" "}
                                {fmtGBP(
                                  (price ?? 0) * (1 - (p.ltv_pct ?? 0) / 100) +
                                    (fees ?? 0) +
                                    (stampDuty ?? 0)
                                )}
                              </div>
                            </div>
                            <PropertyFiles propertyId={p.id} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}

                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={13} className="muted">
                      No properties found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(creating || editing) && (
        <PropertyModal
          title={creating ? "Add property" : "Edit property"}
          initial={editing ?? undefined}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSave={async (payload) => {
            try {
              await upsertProperty(payload);
              setCreating(false);
              setEditing(null);
            } catch (e: any) {
              setError(e?.message ?? "Save failed");
            }
          }}
        />
      )}
    </div>
  );
}