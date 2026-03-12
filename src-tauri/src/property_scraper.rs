use reqwest;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use tokio::time::{sleep, Duration};
use url::Url;
use anyhow::Result;
use serde_json;
use tauri::Emitter;
use rand::Rng;

#[derive(Debug, Serialize, Deserialize)]
pub struct ScrapedProperty {
    pub url: String,
    pub address: String,
    pub price: Option<u64>,
    pub property_type: String,
    pub sector: Option<String>,
    pub bedrooms: Option<u8>,
    pub bathrooms: Option<u8>,
    pub agent: String,
    pub description: String,
    pub tenure: Option<String>,
    pub size_sqft: Option<u32>,
    pub estimated_yield: Option<f64>,
    pub sale_date: Option<String>, // For sold properties
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PropertySearchParams {
    pub min_price: Option<u64>,
    pub max_price: Option<u64>,
    pub property_types: Vec<String>, // "flat", "house", etc.
    pub min_bedrooms: Option<u8>,
    pub tenure: Option<String>, // "freehold", "leasehold"
    pub include_sold: bool,
    pub sold_months_back: Option<u8>,
}

pub struct RightmoveScraper {
    client: reqwest::Client,
}

impl RightmoveScraper {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .cookie_store(true) // Enable cookie handling
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("Failed to create HTTP client");

        Self { client }
    }

    pub async fn search_london_properties(&self, params: &PropertySearchParams, keywords: &[String], app: &tauri::AppHandle) -> Result<Vec<ScrapedProperty>> {
        // Establish session
        println!("Establishing session with Rightmove...");
        let _ = self.client
            .get("https://www.rightmove.co.uk")
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8")
            .header("Accept-Language", "en-GB,en;q=0.9")
            .send()
            .await?;

        let delay_ms = {
            let mut rng = rand::thread_rng();
            rng.gen_range(1000..3000)
        };
        sleep(Duration::from_millis(delay_ms)).await;

        let base_url = self.build_search_url(params)?;

        // Search for each keyword separately using Rightmove's keywords param
        // This lets Rightmove filter server-side for relevant listings
        let mut seen_urls = std::collections::HashSet::new();
        let mut all_properties = Vec::new();
        let total_keywords = keywords.len().max(1);

        for (ki, keyword) in keywords.iter().enumerate() {
            let keyword = keyword.trim();
            if keyword.is_empty() { continue; }

            let encoded_keyword = keyword.replace(' ', "+");
            let search_url = format!("{}&keywords={}", base_url, encoded_keyword);
            println!("Searching keyword '{}': {}", keyword, search_url);

            let progress = 10 + (70 * ki / total_keywords);
            let _ = app.emit("search_progress", serde_json::json!({
                "progress": progress,
                "message": format!("Searching '{}'... ({}/{})", keyword, ki + 1, total_keywords)
            }));

            // Only fetch page 1 per keyword to keep it fast
            let page_url = format!("{}&index=0", search_url);

            match self.scrape_search_results_page(&page_url).await {
                Ok(properties) => {
                    println!("Found {} properties for keyword '{}'", properties.len(), keyword);
                    for p in properties {
                        if seen_urls.insert(p.url.clone()) {
                            all_properties.push(p);
                        }
                    }
                },
                Err(e) => {
                    println!("Error searching keyword '{}': {}", keyword, e);
                }
            }

            // Delay between keyword searches
            let delay_secs = {
                let mut rng = rand::thread_rng();
                rng.gen_range(2..=5)
            };
            sleep(Duration::from_secs(delay_secs)).await;
        }

        // Keep only plots, land, or properties in the "Land for sale" sector
        all_properties.retain(|p| {
            let pt = p.property_type.to_lowercase();
            let sec = p.sector.as_deref().unwrap_or("").to_lowercase();
            pt.contains("plot") || pt.contains("land") || sec.contains("land")
        });

        println!("Total unique land/plot properties found: {}", all_properties.len());
        Ok(all_properties)
    }

    fn build_search_url(&self, params: &PropertySearchParams) -> Result<String> {
        let mut url = Url::parse("https://www.rightmove.co.uk/property-for-sale/find.html")?;

        // REGION^87490 = Greater London (inside M25)
        url.query_pairs_mut().append_pair("locationIdentifier", "REGION^87490");
        url.query_pairs_mut().append_pair("numberOfPropertiesPerPage", "24");
        url.query_pairs_mut().append_pair("radius", "0.0");
        url.query_pairs_mut().append_pair("sortType", "2");
        url.query_pairs_mut().append_pair("viewType", "LIST");
        url.query_pairs_mut().append_pair("propertyTypes", "land");

        if let Some(min_price) = params.min_price {
            url.query_pairs_mut().append_pair("minPrice", &min_price.to_string());
        }
        if let Some(max_price) = params.max_price {
            url.query_pairs_mut().append_pair("maxPrice", &max_price.to_string());
        }

        if let Some(min_beds) = params.min_bedrooms {
            url.query_pairs_mut().append_pair("minBedrooms", &min_beds.to_string());
        }

        Ok(url.to_string())
    }

    async fn scrape_search_results_page(&self, url: &str) -> Result<Vec<ScrapedProperty>> {
        println!("Fetching search page: {}", url);

        let response = self.client
            .get(url)
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8")
            .header("Accept-Language", "en-GB,en;q=0.9")
            .header("DNT", "1")
            .header("Connection", "keep-alive")
            .header("Upgrade-Insecure-Requests", "1")
            .header("Sec-Fetch-Dest", "document")
            .header("Sec-Fetch-Mode", "navigate")
            .header("Sec-Fetch-Site", "none")
            .header("Cache-Control", "max-age=0")
            .send()
            .await?;

        let status = response.status();
        println!("Search page response status: {}", status);

        if !status.is_success() {
            return Err(anyhow::anyhow!("Search page request failed: {}", status));
        }

        let html = response.text().await?;
        println!("Search page HTML length: {} chars", html.len());

        self.extract_properties_from_html(&html)
    }

    /// Extract properties from HTML content — tries multiple extraction strategies
    fn extract_properties_from_html(&self, html: &str) -> Result<Vec<ScrapedProperty>> {
        println!("Trying to extract properties from HTML ({} chars)", html.len());

        // Strategy 1: PAGE_MODEL
        if let Some(properties) = self.extract_search_results_from_page_model(html) {
            if !properties.is_empty() {
                println!("Found {} properties from PAGE_MODEL", properties.len());
                return Ok(properties);
            }
        }

        // Strategy 2: Find any JSON object containing a "properties" array
        // Rightmove embeds data in various script tags
        if let Some(properties) = self.extract_properties_from_script_tags(html) {
            if !properties.is_empty() {
                println!("Found {} properties from script tags", properties.len());
                return Ok(properties);
            }
        }

        println!("No properties found in HTML");
        Ok(Vec::new())
    }

    /// Search through all <script> tags for JSON containing property data
    fn extract_properties_from_script_tags(&self, html: &str) -> Option<Vec<ScrapedProperty>> {
        // Look for any script content that contains "properties" array with "displayAddress"
        // Try various window.* assignments
        for marker in &[
            "window.jsonModel = ",
            "window.PAGE_MODEL = ",
            "window.__NEXT_DATA__ = ",
        ] {
            if let Some(start) = html.find(marker) {
                let json_start = start + marker.len();
                let rest = &html[json_start..];

                // Use brace-matching to find the JSON boundary
                let mut depth = 0i32;
                let mut json_end = 0;
                for (i, ch) in rest.char_indices() {
                    match ch {
                        '{' => depth += 1,
                        '}' => {
                            depth -= 1;
                            if depth == 0 {
                                json_end = i + 1;
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                if json_end == 0 { continue; }

                let json_str = &rest[..json_end];
                println!("Found {} marker, JSON size: {} chars", marker.trim(), json_str.len());

                if let Ok(model) = serde_json::from_str::<serde_json::Value>(json_str) {
                    // Print top-level keys for debugging
                    if let Some(obj) = model.as_object() {
                        let keys: Vec<&String> = obj.keys().collect();
                        println!("Top-level keys: {:?}", keys);
                    }

                    // Try to find properties at various paths
                    let props_value = model.get("properties")
                        .or_else(|| model.get("searchResults").and_then(|sr| sr.get("properties")))
                        .or_else(|| model.get("props").and_then(|p| p.get("pageProps")).and_then(|pp| pp.get("properties")));

                    if let Some(arr) = props_value.and_then(|v| v.as_array()) {
                        println!("Found properties array with {} items", arr.len());
                        let results = self.parse_properties_array(arr);
                        if !results.is_empty() {
                            return Some(results);
                        }
                    }
                }
            }
        }

        // Last resort: find "properties":[{...}] arrays directly in HTML
        // This handles bundled JS where the data isn't in a clean JSON object
        let mut search_from = 0;
        while let Some(pos) = html[search_from..].find("\"properties\":[{") {
            let abs_pos = search_from + pos;
            // Find the start of the array (skip past "properties":)
            let arr_start = abs_pos + "\"properties\":".len();
            let rest = &html[arr_start..];

            // Bracket-match to find the end of the array
            let mut depth = 0i32;
            let mut arr_end = 0;
            let mut in_string = false;
            let mut escape_next = false;
            for (i, ch) in rest.char_indices() {
                if escape_next {
                    escape_next = false;
                    continue;
                }
                if ch == '\\' && in_string {
                    escape_next = true;
                    continue;
                }
                if ch == '"' {
                    in_string = !in_string;
                    continue;
                }
                if in_string { continue; }
                match ch {
                    '[' => depth += 1,
                    ']' => {
                        depth -= 1;
                        if depth == 0 {
                            arr_end = i + 1;
                            break;
                        }
                    }
                    _ => {}
                }
            }

            if arr_end > 0 {
                let arr_str = &rest[..arr_end];
                println!("Found properties array at pos {}, length {} chars", abs_pos, arr_str.len());

                if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(arr_str) {
                    println!("Parsed properties array: {} items", arr.len());
                    // Check if first item has displayAddress
                    if arr.first().map_or(false, |item| item.get("displayAddress").is_some()) {
                        let results = self.parse_properties_array(&arr);
                        if !results.is_empty() {
                            println!("Extracted {} properties from inline array", results.len());
                            return Some(results);
                        }
                    }
                } else {
                    println!("Failed to parse properties array JSON");
                }
            }

            search_from = abs_pos + 1;
        }

        None
    }

    /// Parse an array of property JSON objects into ScrapedProperty structs
    fn parse_properties_array(&self, properties: &[serde_json::Value]) -> Vec<ScrapedProperty> {
        let mut results = Vec::new();
        for prop in properties {
            let address = prop.get("displayAddress")
                .or_else(|| prop.get("address").and_then(|a| a.get("displayAddress")))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            if address.is_empty() { continue; }

            let price = prop.get("price")
                .and_then(|p| {
                    p.get("amount").and_then(|v| v.as_u64())
                        .or_else(|| p.get("amount").and_then(|v| v.as_str()).and_then(|s| self.parse_price(s)))
                        .or_else(|| {
                            p.get("displayPrices")
                                .and_then(|d| d.as_array())
                                .and_then(|a| a.first())
                                .and_then(|dp| dp.get("displayPrice"))
                                .and_then(|v| v.as_str())
                                .and_then(|s| self.parse_price(s))
                        })
                });

            let property_type = prop.get("propertySubType")
                .or_else(|| prop.get("propertyType"))
                .and_then(|v| v.as_str())
                .unwrap_or("Property")
                .to_string();

            let sector = prop.get("channel")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let bedrooms = prop.get("bedrooms")
                .and_then(|v| v.as_u64())
                .map(|v| v as u8);

            let bathrooms = prop.get("bathrooms")
                .and_then(|v| v.as_u64())
                .map(|v| v as u8);

            let agent = prop.get("customer")
                .and_then(|c| c.get("branchDisplayName"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let description = prop.get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let property_url = prop.get("propertyUrl")
                .and_then(|v| v.as_str())
                .map(|u| {
                    if u.starts_with("http") { u.to_string() }
                    else { format!("https://www.rightmove.co.uk{}", u) }
                })
                .or_else(|| {
                    prop.get("id")
                        .and_then(|v| v.as_u64())
                        .map(|id| format!("https://www.rightmove.co.uk/properties/{}", id))
                })
                .unwrap_or_default();

            results.push(ScrapedProperty {
                url: property_url,
                address,
                price,
                property_type,
                sector,
                bedrooms,
                bathrooms,
                agent,
                description: self.clean_html(&description),
                tenure: None,
                size_sqft: None,
                estimated_yield: None,
                sale_date: None,
            });
        }
        results
    }

    fn extract_search_results_from_page_model(&self, html: &str) -> Option<Vec<ScrapedProperty>> {
        let marker = "window.PAGE_MODEL = ";
        let start = html.find(marker)?;
        let json_start = start + marker.len();

        let rest = &html[json_start..];
        let mut depth = 0i32;
        let mut json_end = 0;
        for (i, ch) in rest.char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        json_end = i + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        if json_end == 0 { return None; }
        let json_str = &rest[..json_end];

        let model: serde_json::Value = serde_json::from_str(json_str).ok()?;

        let properties_array = model.get("properties").and_then(|v| v.as_array())?;

        let mut results = Vec::new();
        for prop in properties_array {
            let address = prop.get("displayAddress")
                .or_else(|| prop.get("propertyCard").and_then(|c| c.get("displayAddress")))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            if address.is_empty() {
                continue;
            }

            let price_str = prop.get("price")
                .and_then(|p| p.get("displayPrices").and_then(|d| d.as_array()).and_then(|a| a.first()))
                .and_then(|p| p.get("displayPrice"))
                .and_then(|v| v.as_str())
                .or_else(|| prop.get("price").and_then(|p| p.get("amount")).and_then(|v| v.as_str()))
                .unwrap_or("");
            let price = self.parse_price(price_str)
                .or_else(|| prop.get("price").and_then(|p| p.get("amount")).and_then(|v| v.as_u64()));

            let property_type = prop.get("propertySubType")
                .or_else(|| prop.get("propertyType"))
                .and_then(|v| v.as_str())
                .unwrap_or("Property")
                .to_string();

            let sector = prop.get("channel")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let bedrooms = prop.get("bedrooms")
                .and_then(|v| v.as_u64())
                .map(|v| v as u8);

            let bathrooms = prop.get("bathrooms")
                .and_then(|v| v.as_u64())
                .map(|v| v as u8);

            let agent = prop.get("customer")
                .and_then(|c| c.get("branchDisplayName"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let description = prop.get("summary")
                .or_else(|| prop.get("propertyCard").and_then(|c| c.get("summary")))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let property_id = prop.get("id")
                .and_then(|v| v.as_u64())
                .map(|id| format!("https://www.rightmove.co.uk/properties/{}", id))
                .unwrap_or_default();

            let property_url = prop.get("propertyUrl")
                .and_then(|v| v.as_str())
                .map(|u| {
                    if u.starts_with("http") { u.to_string() }
                    else { format!("https://www.rightmove.co.uk{}", u) }
                })
                .unwrap_or(property_id);

            results.push(ScrapedProperty {
                url: property_url,
                address,
                price,
                property_type,
                sector,
                bedrooms,
                bathrooms,
                agent,
                description: self.clean_html(&description),
                tenure: None,
                size_sqft: None,
                estimated_yield: None,
                sale_date: None,
            });
        }

        Some(results)
    }

    fn parse_price(&self, price_text: &str) -> Option<u64> {
        let clean_price = price_text
            .replace("£", "")
            .replace(",", "")
            .replace("POA", "")
            .replace("Guide Price", "")
            .trim()
            .to_string();

        clean_price.parse().ok()
    }

    fn clean_html(&self, html: &str) -> String {
        html.replace("<br>", " ")
            .replace("&amp;", "&")
            .trim()
            .to_string()
    }

    pub async fn scrape_single_property(&self, url: &str) -> Result<ScrapedProperty> {
        println!("Scraping individual property: {}", url);

        // Add delay to mimic human behavior
        let delay_ms = {
            let mut rng = rand::thread_rng();
            rng.gen_range(1000..3000)
        };
        sleep(Duration::from_millis(delay_ms)).await;

        let response = self.client
            .get(url)
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8")
            .header("Accept-Language", "en-GB,en;q=0.9,en-US;q=0.8")
            .header("DNT", "1")
            .header("Connection", "keep-alive")
            .header("Upgrade-Insecure-Requests", "1")
            .header("Sec-Fetch-Dest", "document")
            .header("Sec-Fetch-Mode", "navigate")
            .header("Sec-Fetch-Site", "none")
            .header("Cache-Control", "max-age=0")
            .send()
            .await?;

        println!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!("HTTP request failed with status: {}", response.status()));
        }

        let html = response.text().await?;

        // Try to extract from embedded PAGE_MODEL JSON first (Rightmove renders via JS)
        if let Some(property) = self.extract_from_page_model(&html, url) {
            return Ok(property);
        }

        // Fallback: try CSS selectors on the raw HTML
        let document = Html::parse_document(&html);

        let address = self.extract_detail(&document, &[
            "h1[data-test='property-address']",
            ".property-address h1",
            "h1.fs-22",
            ".property-header-wrapper h1"
        ]);

        let price_text = self.extract_detail(&document, &[
            "[data-test='price-display']",
            ".property-price",
            ".price .fs-35",
            "._1gfnqJ3Vtd1z40MlC0MzXu span"
        ]);

        let property_type = self.extract_detail(&document, &[
            "[data-test='property-type']",
            ".property-type",
            ".property-details .property-type"
        ]);

        let bedrooms_text = self.extract_detail(&document, &[
            "[data-test='beds-label']",
            ".property-icon-bed + span",
            ".property-features .beds"
        ]);

        let bathrooms_text = self.extract_detail(&document, &[
            "[data-test='baths-label']",
            ".property-icon-bath + span",
            ".property-features .baths"
        ]);

        let tenure = self.extract_detail(&document, &[
            "[data-test='tenure']",
            ".tenure",
            ".property-details .tenure"
        ]);

        let agent = self.extract_detail(&document, &[
            ".agent-name",
            ".branch-name",
            "[data-test='agent-name']",
            ".contact-agent .agent-details h2"
        ]);

        let description = self.extract_detail(&document, &[
            "[data-test='property-description']",
            ".property-description",
            "#property-description",
            ".description"
        ]);

        let size_text = self.extract_detail(&document, &[
            "[data-test='floorarea']",
            ".floor-area",
            ".property-size"
        ]);

        let price = self.parse_price(&price_text);
        let bedrooms = self.parse_number(&bedrooms_text);
        let bathrooms = self.parse_number(&bathrooms_text);
        let size_sqft = self.parse_size(&size_text);

        println!("Extracted property details: {} - {} - {} - Agent: {}",
                 address, price_text, property_type, agent);

        if address.is_empty() {
            return Err(anyhow::anyhow!("Could not extract property address from page. Rightmove may have blocked the request or changed their page structure."));
        }

        Ok(ScrapedProperty {
            url: url.to_string(),
            address: self.clean_html(&address),
            price,
            property_type: if property_type.is_empty() { "Property".to_string() } else { self.clean_html(&property_type) },
            sector: None,
            bedrooms,
            bathrooms,
            agent: self.clean_html(&agent),
            description: self.clean_html(&description),
            tenure: if tenure.is_empty() { None } else { Some(self.clean_html(&tenure)) },
            size_sqft,
            estimated_yield: None,
            sale_date: None,
        })
    }

    fn extract_from_page_model(&self, html: &str, url: &str) -> Option<ScrapedProperty> {
        // Rightmove embeds property data as window.PAGE_MODEL = {...} in a <script> tag
        let marker = "window.PAGE_MODEL = ";
        let start = html.find(marker)?;
        let json_start = start + marker.len();

        // Find the end of the JSON object by matching braces
        let rest = &html[json_start..];
        let mut depth = 0i32;
        let mut json_end = 0;
        for (i, ch) in rest.char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        json_end = i + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        if json_end == 0 {
            return None;
        }
        let json_str = &rest[..json_end];

        let model: serde_json::Value = serde_json::from_str(json_str).ok()?;
        let property_data = model.get("propertyData")?;

        let address = property_data.get("address")
            .and_then(|a| a.get("displayAddress"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if address.is_empty() {
            return None;
        }

        let price = property_data.get("prices")
            .and_then(|p| p.get("primaryPrice"))
            .and_then(|v| v.as_str())
            .and_then(|s| self.parse_price(s));

        let property_type = property_data.get("propertySubType")
            .and_then(|v| v.as_str())
            .unwrap_or("Property")
            .to_string();

        let bedrooms = property_data.get("bedrooms")
            .and_then(|v| v.as_u64())
            .map(|v| v as u8);

        let bathrooms = property_data.get("bathrooms")
            .and_then(|v| v.as_u64())
            .map(|v| v as u8);

        let tenure = property_data.get("tenure")
            .and_then(|t| t.get("tenureType"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let agent = property_data.get("customer")
            .and_then(|c| c.get("branchDisplayName"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let description = property_data.get("text")
            .and_then(|t| t.get("description"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let size_sqft = property_data.get("sizings")
            .and_then(|s| s.as_array())
            .and_then(|arr| arr.first())
            .and_then(|s| s.get("maximumSize"))
            .and_then(|v| v.as_f64())
            .map(|v| v as u32);

        Some(ScrapedProperty {
            url: url.to_string(),
            address,
            price,
            property_type,
            sector: None,
            bedrooms,
            bathrooms,
            agent,
            description: self.clean_html(&description),
            tenure,
            size_sqft,
            estimated_yield: None,
            sale_date: None,
        })
    }

    fn extract_detail(&self, document: &Html, selectors: &[&str]) -> String {
        for selector_str in selectors {
            if let Ok(selector) = Selector::parse(selector_str) {
                if let Some(element) = document.select(&selector).next() {
                    let text = element.text().collect::<String>().trim().to_string();
                    if !text.is_empty() {
                        return text;
                    }
                }
            }
        }
        String::new()
    }

    fn parse_number(&self, text: &str) -> Option<u8> {
        text.chars()
            .filter(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .ok()
    }

    fn parse_size(&self, size_text: &str) -> Option<u32> {
        // Try to extract square footage from text like "1,200 sq ft" or "120 m²"
        let clean_text = size_text.replace(",", "");

        // Look for sq ft first
        if let Some(sqft_match) = clean_text.split("sq ft").next() {
            if let Ok(sqft) = sqft_match.trim().parse::<u32>() {
                return Some(sqft);
            }
        }

        // Look for m² and convert to sq ft
        if let Some(sqm_match) = clean_text.split("m²").next() {
            if let Ok(sqm) = sqm_match.trim().parse::<f64>() {
                return Some((sqm * 10.764) as u32); // Convert to sq ft
            }
        }

        None
    }

    pub async fn estimate_gross_yield(&self, price: u64, _address: &str) -> Option<f64> {
        // This is a simplified yield estimation
        // In reality, you'd want to look up rental prices for the area
        // For now, we'll use London average rent estimates
        let estimated_monthly_rent = match price {
            0..=500_000 => price as f64 * 0.004, // 0.4% of property value per month
            500_001..=1_000_000 => price as f64 * 0.0035,
            1_000_001..=2_000_000 => price as f64 * 0.003,
            _ => price as f64 * 0.0025,
        };

        let annual_rent = estimated_monthly_rent * 12.0;
        let gross_yield = (annual_rent / price as f64) * 100.0;

        Some(gross_yield)
    }
}