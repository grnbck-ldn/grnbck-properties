// Simple geocoding service using Nominatim (OpenStreetMap) - free, no API key needed
import { fetch } from "@tauri-apps/plugin-http";

export interface Coordinates {
  lat: number;
  lng: number;
}

// In-memory cache to avoid re-geocoding on component remounts
const cache = new Map<string, Coordinates>();

async function geocodeAddress(address: string): Promise<Coordinates | null> {
  // Check cache first
  if (cache.has(address)) return cache.get(address)!;

  try {
    const query = address.toLowerCase().includes('london') ? address : `${address}, London, UK`;
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1&countrycodes=gb`;

    const response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "grnbck-properties/1.0 (property-tool)" },
    });

    // Rate limited — wait and retry once
    if (response.status === 429) {
      await new Promise(r => setTimeout(r, 3000));
      const retry = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": "grnbck-properties/1.0 (property-tool)" },
      });
      if (!retry.ok) return null;
      const results = await retry.json();
      if (!results || results.length === 0) return null;
      const coords = { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
      cache.set(address, coords);
      return coords;
    }

    if (!response.ok) return null;

    const results = await response.json();
    if (!results || results.length === 0) return null;

    const coords = { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
    cache.set(address, coords);
    return coords;
  } catch (error) {
    console.error('Geocoding error for', address, error);
    return null;
  }
}

// Batch geocode multiple addresses with rate limiting
export async function geocodeAddresses(addresses: string[]): Promise<Map<string, Coordinates>> {
  const results = new Map<string, Coordinates>();
  const failed: string[] = [];

  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i];

    // Skip delay for cached addresses
    if (!cache.has(address) && i > 0) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    const coords = await geocodeAddress(address);
    if (coords) {
      results.set(address, coords);
    } else {
      failed.push(address);
    }
  }

  if (failed.length > 0) {
    console.warn("Failed to geocode:", failed);
  }

  return results;
}
