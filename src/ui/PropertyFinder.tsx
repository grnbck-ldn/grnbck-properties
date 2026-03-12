import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import { fmtGBP } from "../lib/finance";

interface ScrapedProperty {
  url: string;
  address: string;
  price?: number;
  property_type: string;
  sector?: string;
  bedrooms?: number;
  bathrooms?: number;
  agent: string;
  description: string;
  tenure?: string;
  size_sqft?: number;
  estimated_yield?: number;
  sale_date?: string;
}

interface Props {
  onAddProperty: (property: any) => void;
  existingUrls: Set<string>;
}

// Module-level cache so results survive component remounts
let _cached: ScrapedProperty[] = [];
const _dismissed = new Set<string>();

export function PropertyFinder({ onAddProperty, existingUrls }: Props) {
  const [loading, setLoading] = useState(false);
  const [foundProperties, setFoundProperties] = useState<ScrapedProperty[]>(_cached);
  const [error, setError] = useState<string | null>(null);

  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");

  const [minPrice, setMinPrice] = useState(400000);
  const [maxPrice, setMaxPrice] = useState(3000000);
  const [keywords, setKeywords] = useState("development site,building plot,planning permission,brownfield,greenfield,residential development,planning consent,self build");

  // Sync to module cache
  useEffect(() => { _cached = foundProperties; }, [foundProperties]);

  useEffect(() => {
    const unlisten = listen('search_progress', (event: any) => {
      const { progress: progressValue, message } = event.payload;
      setProgress(progressValue);
      setProgressMessage(message);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  async function findInvestmentProperties() {
    setLoading(true);
    setError(null);
    setProgress(0);
    setProgressMessage("Starting search...");
    try {
      const properties = await invoke<ScrapedProperty[]>("find_investment_properties", {
        minPrice,
        maxPrice,
        keywords: keywords.split(',').map(k => k.trim()).filter(k => k.length > 0)
      });
      // Filter out properties already in portfolio or previously dismissed/added
      const filtered = properties.filter(p => !existingUrls.has(p.url) && !_dismissed.has(p.url));
      setFoundProperties(filtered);
      console.log(`Found ${properties.length} properties, ${filtered.length} new`);
    } catch (err) {
      setError(`Failed to find properties: ${err}`);
      console.error("Property search error:", err);
    } finally {
      setLoading(false);
      setProgress(0);
      setProgressMessage("");
    }
  }

  async function approveProperty(property: ScrapedProperty) {
    const newProperty = {
      address: property.address,
      price_gbp: property.price || null,
      annual_rent_gbp: property.price ? (property.price * (property.estimated_yield || 6) / 100) : null,
      listing_url: property.url,
      selling_agent: property.agent,
      property_type: "residential" as const,
      ltv_pct: 75,
      interest_rate_pct: 6,
      hold_period_years: 5,
      rent_growth_pct: 2,
      value_growth_pct: 2,
      fees_pct: 0.01,
    };

    try {
      await onAddProperty(newProperty);
      _dismissed.add(property.url);
      setFoundProperties(prev => prev.filter(p => p.url !== property.url));
    } catch (err) {
      console.error("Failed to add property:", err);
      setError(`Failed to add property: ${err}`);
    }
  }

  function declineProperty(property: ScrapedProperty) {
    _dismissed.add(property.url);
    setFoundProperties(prev => prev.filter(p => p.url !== property.url));
  }

  async function openListing(url: string) {
    try {
      await open(url);
    } catch (err) {
      console.error("Failed to open listing:", err);
    }
  }

  return (
    <div className="card">
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: 0, marginBottom: 8 }}>Land & Plot Finder</h3>
        <p className="small muted" style={{ margin: 0 }}>
          Find land and development plots for sale in London
        </p>
      </div>

      <div style={{ marginBottom: 16, background: "rgba(255,255,255,0.04)", padding: 16, borderRadius: 8 }}>
        <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label className="small" style={{ display: "block", marginBottom: 4, color: "var(--muted)" }}>Min Price</label>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="small muted">£</span>
              <input
                type="number"
                value={minPrice}
                onChange={(e) => setMinPrice(parseInt(e.target.value) || 0)}
                style={{ width: "100%" }}
              />
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <label className="small" style={{ display: "block", marginBottom: 4, color: "var(--muted)" }}>Max Price</label>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="small muted">£</span>
              <input
                type="number"
                value={maxPrice}
                onChange={(e) => setMaxPrice(parseInt(e.target.value) || 0)}
                style={{ width: "100%" }}
              />
            </div>
          </div>
        </div>
        <div>
          <label className="small" style={{ display: "block", marginBottom: 4, color: "var(--muted)" }}>
            Keywords (comma-separated)
          </label>
          <input
            type="text"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="development site,building plot,planning permission..."
            style={{ width: "100%" }}
          />
          <p className="small muted" style={{ margin: "4px 0 0 0", fontSize: 10 }}>
            Each keyword is searched on Rightmove separately. Only plots and land listings are shown.
          </p>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 16, gap: 8 }}>
        <button
          onClick={findInvestmentProperties}
          disabled={loading}
          style={{ background: loading ? "rgba(125,211,252,0.1)" : "rgba(125,211,252,0.14)" }}
        >
          {loading ? "Searching..." : "Find Properties"}
        </button>
      </div>

      {loading && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="small" style={{ color: "var(--accent)" }}>
              {progressMessage}
            </span>
            <span className="small" style={{ color: "var(--muted)" }}>
              {Math.round(progress)}%
            </span>
          </div>
          <div style={{
            width: "100%",
            height: 8,
            background: "rgba(255,255,255,0.1)",
            borderRadius: 4,
            overflow: "hidden"
          }}>
            <div style={{
              width: `${progress}%`,
              height: "100%",
              background: "linear-gradient(90deg, #3B82F6, #06B6D4)",
              borderRadius: 4,
              transition: "width 0.3s ease"
            }} />
          </div>
        </div>
      )}

      {error && (
        <div style={{
          background: "rgba(239, 68, 68, 0.1)",
          border: "1px solid rgba(239, 68, 68, 0.3)",
          borderRadius: 8,
          padding: 12,
          marginBottom: 16,
          color: "#EF4444"
        }}>
          {error}
        </div>
      )}

      {foundProperties.length > 0 && (
        <div>
          <h4 style={{ margin: "0 0 12px 0", color: "var(--accent)" }}>
            {foundProperties.length} Land & Plot Listings
          </h4>

          <div style={{ display: "grid", gap: "12px" }}>
            {foundProperties.map((property, index) => (
              <div key={property.url || index} style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: 16
              }}>
                <div className="row between" style={{ marginBottom: 8 }}>
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                      {property.address}
                    </div>
                    <div className="small muted">
                      {property.agent} • {property.property_type}{property.sector ? ` • ${property.sector}` : ""}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>
                      {property.price ? fmtGBP(property.price) : "POA"}
                    </div>
                  </div>
                </div>

                {property.description && (
                  <div className="small muted" style={{
                    marginBottom: 12,
                    maxHeight: 60,
                    overflow: "hidden",
                    textOverflow: "ellipsis"
                  }}>
                    {property.description.slice(0, 200)}...
                  </div>
                )}

                <div className="row between">
                  <button
                    className="linkButton"
                    onClick={() => openListing(property.url)}
                    style={{ fontSize: 12 }}
                  >
                    View Listing
                  </button>

                  <div className="row" style={{ gap: 8 }}>
                    <button
                      className="danger"
                      onClick={() => declineProperty(property)}
                      style={{ fontSize: 12, padding: "6px 12px" }}
                    >
                      Pass
                    </button>
                    <button
                      onClick={() => approveProperty(property)}
                      style={{
                        fontSize: 12,
                        padding: "6px 12px",
                        background: "rgba(16, 185, 129, 0.14)",
                        borderColor: "rgba(16, 185, 129, 0.35)"
                      }}
                    >
                      Add to Portfolio
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && foundProperties.length === 0 && (
        <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🏠</div>
          <div>Click "Find Properties" to discover land and plots</div>
          <div className="small" style={{ marginTop: 4 }}>
            Searches Greater London for land and development plots listed as Plot or Land for sale
          </div>
        </div>
      )}
    </div>
  );
}