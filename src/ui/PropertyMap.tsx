import React, { useEffect, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Popup } from "react-leaflet";
import { open } from "@tauri-apps/plugin-shell";
import L from "leaflet";
import { PropertyRow } from "../lib/types";
import { geocodeAddresses, Coordinates } from "../lib/geocoding";
import { fmtGBP, fmtPct, calcNetYield, calcTotalReturnOnEquity } from "../lib/finance";

// Function to get marker color based on ROE performance
function getMarkerColor(roePct: number | null): string {
  if (roePct == null) return '#6B7280'; // Gray for unknown
  if (roePct >= 0.15) return '#10B981'; // Green for 15%+ ROE (excellent)
  if (roePct >= 0.10) return '#F59E0B'; // Yellow for 10-15% ROE (good)
  return '#EF4444'; // Red for <10% ROE (poor)
}

type Props = {
  properties: PropertyRow[];
};

export function PropertyMap({ properties }: Props) {
  const [coordinates, setCoordinates] = useState<Map<string, Coordinates>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (properties.length === 0) return;

    async function loadCoordinates() {
      setLoading(true);
      setError(null);

      try {
        // Get unique addresses
        const addresses = [...new Set(properties.map(p => p.address))];

        // Geocode all addresses
        const coords = await geocodeAddresses(addresses);
        setCoordinates(coords);

        if (coords.size === 0) {
          setError("Could not geocode any addresses. Please check property addresses.");
        } else if (coords.size < addresses.length) {
          setError(`Geocoded ${coords.size} of ${addresses.length} addresses. Some properties may not appear on the map.`);
        }
      } catch (err) {
        setError("Failed to load property locations.");
        console.error("Geocoding error:", err);
      } finally {
        setLoading(false);
      }
    }

    loadCoordinates();
  }, [properties]);

  // London center coordinates
  const londonCenter: [number, number] = [51.5074, -0.1278];

  if (loading) {
    return (
      <div className="card" style={{ padding: "40px", textAlign: "center" }}>
        <p>Loading property locations...</p>
        <p className="small muted">This may take a few moments for many properties.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Property Map</h3>
        {error && (
          <p className="small" style={{ color: "#fb7185", marginTop: 4 }}>
            {error}
          </p>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
          <p className="small muted" style={{ margin: 0 }}>
            {coordinates.size} properties plotted on map
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '11px' }}>
            <span style={{ color: 'var(--muted)' }}>Legend:</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: '#10B981', border: '2px solid white' }}></div>
              <span style={{ color: 'var(--muted)' }}>15%+ ROE</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: '#F59E0B', border: '2px solid white' }}></div>
              <span style={{ color: 'var(--muted)' }}>10-15% ROE</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: '#EF4444', border: '2px solid white' }}></div>
              <span style={{ color: 'var(--muted)' }}>&lt;10% ROE</span>
            </div>
          </div>
        </div>
      </div>

      <div style={{ height: 500, borderRadius: 12, overflow: "hidden" }}>
        <MapContainer
          center={londonCenter}
          zoom={10}
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {properties.map((property) => {
            const coords = coordinates.get(property.address);
            if (!coords) return null;

            // Calculate financial metrics for popup
            const price = property.price_gbp ?? null;
            const fees = price != null ? price * (property.fees_pct ?? 0.01) : null;
            const stampDuty = property.stamp_duty_gbp ?? null;

            const yieldPct = calcNetYield({
              sqm: property.sqm,
              annualRent: property.annual_rent_gbp,
              opexPerSqm: property.opex_per_sqm_gbp_per_year,
              price,
              fees,
              stampDuty,
            });

            const totalReturnOnEquity = calcTotalReturnOnEquity({
              price,
              fees,
              stampDuty,
              annualRent: property.annual_rent_gbp,
              sqm: property.sqm,
              opexPerSqm: property.opex_per_sqm_gbp_per_year,
              ltvPct: property.ltv_pct,
              interestRatePct: property.interest_rate_pct,
              valueGrowthPct: property.value_growth_pct,
            });

            const markerColor = getMarkerColor(totalReturnOnEquity);

            return (
              <CircleMarker
                key={property.id}
                center={[coords.lat, coords.lng]}
                radius={8}
                pathOptions={{
                  fillColor: markerColor,
                  fillOpacity: 0.8,
                  color: '#FFFFFF',
                  weight: 2,
                  opacity: 1,
                }}
              >
                <Popup maxWidth={300}>
                  <div style={{ padding: "8px 0" }}>
                    <div style={{ fontWeight: 600, marginBottom: 8, color: '#1F2937' }}>
                      {property.address}
                    </div>

                    {property.borough && (
                      <div style={{ fontSize: '11px', color: '#6B7280', marginBottom: 8 }}>
                        {property.borough}
                        {property.area && ` • ${property.area}`}
                      </div>
                    )}

                    <div style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "8px",
                      fontSize: "12px",
                      color: '#374151'
                    }}>
                      <div><strong>Price:</strong> {fmtGBP(price)}</div>
                      <div><strong>Rent:</strong> {fmtGBP(property.annual_rent_gbp)}</div>
                      <div><strong>Yield:</strong> {fmtPct(yieldPct)}</div>
                      <div style={{ color: markerColor }}>
                        <strong>ROE:</strong> {fmtPct(totalReturnOnEquity)}
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                      {property.selling_agent && (
                        <div style={{ fontSize: '11px', color: '#6B7280' }}>
                          Agent: {property.selling_agent}
                        </div>
                      )}

                      {property.listing_url && (
                        <button
                          onClick={async () => {
                            try {
                              const url = property.listing_url!.startsWith("http")
                                ? property.listing_url!
                                : `https://${property.listing_url}`;
                              await open(url);
                            } catch (e) {
                              console.error("Failed to open url", e);
                            }
                          }}
                          style={{
                            background: '#3B82F6',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            padding: '4px 8px',
                            fontSize: '11px',
                            cursor: 'pointer',
                            fontWeight: '500',
                          }}
                        >
                          View Listing
                        </button>
                      )}
                    </div>
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>
      </div>
    </div>
  );
}