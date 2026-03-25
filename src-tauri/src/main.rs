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
    keywords: Vec<String>
) -> Result<Vec<ScrapedProperty>, String> {
    let scraper = RightmoveScraper::new();

    let _ = app.emit("search_progress", serde_json::json!({
        "progress": 10,
        "message": "Searching Rightmove..."
    }));

    let params = PropertySearchParams {
        min_price: Some(min_price),
        max_price: Some(max_price),
        property_types: vec!["flat".to_string(), "house".to_string()],
        min_bedrooms: Some(2),
        tenure: None,
        include_sold: false,
        sold_months_back: None,
    };

    match scraper.search_london_properties(&params, &keywords, &app).await {
        Ok(mut properties) => {
            // Add yield estimates
            let total = properties.len();
            for (i, property) in properties.iter_mut().enumerate() {
                if let Some(price) = property.price {
                    property.estimated_yield = scraper.estimate_gross_yield(price, &property.address).await;
                }
                let progress = 80 + (18 * i / total.max(1));
                let _ = app.emit("search_progress", serde_json::json!({
                    "progress": progress,
                    "message": format!("Estimating yields... ({}/{})", i + 1, total)
                }));
            }

            let _ = app.emit("search_progress", serde_json::json!({
                "progress": 100,
                "message": format!("Found {} investment properties!", properties.len())
            }));

            Ok(properties)
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            search_properties,
            search_sold_properties,
            find_investment_properties,
            scrape_property_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
