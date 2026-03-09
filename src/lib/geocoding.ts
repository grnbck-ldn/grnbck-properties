// Simple geocoding service using Nominatim (OpenStreetMap) - free, no API key needed
export interface Coordinates {
  lat: number;
  lng: number;
}

export async function geocodeAddress(address: string): Promise<Coordinates | null> {
  try {
    // Add "London, UK" to improve accuracy if not already specified
    const query = address.toLowerCase().includes('london') ? address : `${address}, London, UK`;

    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1&countrycodes=gb`
    );

    if (!response.ok) return null;

    const results = await response.json();
    if (!results || results.length === 0) return null;

    const result = results[0];
    return {
      lat: parseFloat(result.lat),
      lng: parseFloat(result.lon),
    };
  } catch (error) {
    console.error('Geocoding error:', error);
    return null;
  }
}

// Batch geocode multiple addresses with rate limiting (max 1 request per second)
export async function geocodeAddresses(addresses: string[]): Promise<Map<string, Coordinates>> {
  const results = new Map<string, Coordinates>();

  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i];

    // Rate limiting - wait 1 second between requests
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const coords = await geocodeAddress(address);
    if (coords) {
      results.set(address, coords);
    }
  }

  return results;
}