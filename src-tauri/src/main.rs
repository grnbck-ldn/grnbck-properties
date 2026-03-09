#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod property_scraper;

use property_scraper::{RightmoveScraper, PropertySearchParams, ScrapedProperty};
use tauri::Emitter;

// Tauri command to search for properties
#[tauri::command]
async fn search_properties(app: tauri::AppHandle, params: PropertySearchParams) -> Result<Vec<ScrapedProperty>, String> {
    let scraper = RightmoveScraper::new();

    let default_keywords = vec!["flat".to_string(), "flats".to_string(), "investment".to_string()];
    match scraper.search_london_properties(&params, &default_keywords, &app).await {
        Ok(properties) => Ok(properties),
        Err(e) => Err(format!("Failed to search properties: {}", e)),
    }
}

// Tauri command to search sold properties for market analysis
#[tauri::command]
async fn search_sold_properties(app: tauri::AppHandle, months_back: Option<u8>) -> Result<Vec<ScrapedProperty>, String> {
    let scraper = RightmoveScraper::new();

    let params = PropertySearchParams {
        min_price: Some(200_000),
        max_price: Some(5_000_000),
        property_types: vec!["flat".to_string(), "house".to_string()],
        min_bedrooms: Some(2), // Multi-flat properties usually have 2+ bedrooms
        tenure: Some("freehold".to_string()),
        include_sold: true,
        sold_months_back: months_back.or(Some(24)), // Default to 24 months
    };

    let default_keywords = vec!["flat".to_string(), "flats".to_string(), "investment".to_string()];
    match scraper.search_london_properties(&params, &default_keywords, &app).await {
        Ok(properties) => Ok(properties),
        Err(e) => Err(format!("Failed to search sold properties: {}", e)),
    }
}

// Tauri command to find investment properties matching our criteria
#[tauri::command]
async fn find_investment_properties(
    app: tauri::AppHandle,
    min_price: u64,
    max_price: u64,
    min_yield: f64,
    keywords: Vec<String>
) -> Result<Vec<ScrapedProperty>, String> {
    let scraper = RightmoveScraper::new();

    // Emit progress: Starting search
    let _ = app.emit("search_progress", serde_json::json!({
        "progress": 10,
        "message": "Searching Rightmove..."
    }));

    let params = PropertySearchParams {
        min_price: Some(min_price),
        max_price: Some(max_price),
        property_types: vec!["flat".to_string(), "house".to_string()],
        min_bedrooms: Some(2), // Minimum for investment properties
        tenure: None, // We'll filter for freehold in post-processing
        include_sold: false,
        sold_months_back: None,
    };

    match scraper.search_london_properties(&params, &keywords, &app).await {
        Ok(mut properties) => {
            // Emit progress: Processing results
            let _ = app.emit("search_progress", serde_json::json!({
                "progress": 80,
                "message": format!("Calculating yields for {} properties...", properties.len())
            }));

            // Add yield estimates
            let total_properties = properties.len();
            for (index, property) in properties.iter_mut().enumerate() {
                if let Some(price) = property.price {
                    property.estimated_yield = scraper.estimate_gross_yield(price, &property.address).await;
                }

                // Update progress during yield calculation
                let yield_progress = 80 + (15 * index / total_properties.max(1));
                let _ = app.emit("search_progress", serde_json::json!({
                    "progress": yield_progress,
                    "message": format!("Calculating yields... ({}/{} done)", index + 1, total_properties)
                }));
            }

            // Emit progress: Filtering results
            let _ = app.emit("search_progress", serde_json::json!({
                "progress": 95,
                "message": "Filtering by yield criteria..."
            }));

            // Filter for minimum yield if specified
            let filtered: Vec<ScrapedProperty> = properties.into_iter()
                .filter(|p| {
                    if min_yield > 0.0 {
                        p.estimated_yield.map_or(false, |yield_pct| yield_pct >= min_yield)
                    } else {
                        true // No yield filter if 0
                    }
                })
                .collect();

            // Emit final progress
            let _ = app.emit("search_progress", serde_json::json!({
                "progress": 100,
                "message": format!("Found {} investment properties!", filtered.len())
            }));

            Ok(filtered)
        },
        Err(e) => Err(format!("Failed to find investment properties: {}", e)),
    }
}

// Tauri command to scrape details from a single property URL
#[tauri::command]
async fn scrape_property_url(url: String) -> Result<ScrapedProperty, String> {
    let scraper = RightmoveScraper::new();

    match scraper.scrape_single_property(&url).await {
        Ok(property) => Ok(property),
        Err(e) => Err(format!("Failed to scrape property: {}", e)),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            search_properties,
            search_sold_properties,
            find_investment_properties,
            scrape_property_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
