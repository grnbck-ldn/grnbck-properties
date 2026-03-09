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
        // First, visit the main Rightmove page to establish a session
        println!("Establishing session with Rightmove...");
        let _ = self.client
            .get("https://www.rightmove.co.uk")
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8")
            .header("Accept-Language", "en-GB,en;q=0.9")
            .send()
            .await?;

        // Small delay to mimic human behavior
        let delay_ms = {
            let mut rng = rand::thread_rng();
            rng.gen_range(1000..3000)
        };
        sleep(Duration::from_millis(delay_ms)).await;

        let search_url = self.build_search_url(params)?;
        println!("Starting property search: {}", search_url);

        let mut all_properties = Vec::new();
        let mut page = 0;
        let max_pages = 5; // Limit to prevent excessive scraping

        loop {
            if page >= max_pages {
                break;
            }

            // Emit progress update
            let progress = 20 + (50 * page / max_pages); // 20-70% for scraping pages
            let _ = app.emit("search_progress", serde_json::json!({
                "progress": progress,
                "message": format!("Scraping page {} of {}...", page + 1, max_pages)
            }));

            let page_url = format!("{}&index={}", search_url, page * 24);

            match self.scrape_search_results_page(&page_url).await {
                Ok(properties) => {
                    println!("Found {} properties on page {}", properties.len(), page + 1);

                    if properties.is_empty() {
                        println!("No properties found on page {}, stopping search", page + 1);
                        break; // No more properties
                    }

                    all_properties.extend(properties);
                },
                Err(e) => {
                    println!("Error scraping page {}: {}", page + 1, e);
                    // Continue to next page instead of failing completely
                }
            }

            // Random delay between 3-8 seconds to look more human
            let delay_secs = {
                let mut rng = rand::thread_rng();
                rng.gen_range(3..=8)
            };
            println!("Waiting {} seconds before next page...", delay_secs);
            sleep(Duration::from_secs(delay_secs)).await;
            page += 1;
        }

        // Filter properties that match investment keywords
        let filtered: Vec<ScrapedProperty> = all_properties.into_iter()
            .filter(|p| self.matches_investment_keywords(&p.description, keywords))
            .collect();

        Ok(filtered)
    }

    fn build_search_url(&self, params: &PropertySearchParams) -> Result<String> {
        let mut url = Url::parse("https://www.rightmove.co.uk/property-for-sale/find.html")?;

        // London location ID (this is Rightmove's ID for Greater London)
        url.query_pairs_mut().append_pair("locationIdentifier", "REGION^876");

        // Property types - focus on flats and houses that could be multi-flat
        url.query_pairs_mut().append_pair("propertyTypes", "flat,house");

        // Price range
        if let Some(min_price) = params.min_price {
            url.query_pairs_mut().append_pair("minPrice", &min_price.to_string());
        }
        if let Some(max_price) = params.max_price {
            url.query_pairs_mut().append_pair("maxPrice", &max_price.to_string());
        }

        // Minimum bedrooms (multi-flat properties usually have more bedrooms)
        if let Some(min_beds) = params.min_bedrooms {
            url.query_pairs_mut().append_pair("minBedrooms", &min_beds.to_string());
        }

        // Include sold properties if requested
        if params.include_sold {
            // Switch to sold property search
            let mut sold_url = Url::parse("https://www.rightmove.co.uk/house-prices/search.html")?;
            sold_url.query_pairs_mut().append_pair("locationIdentifier", "REGION^876");
            sold_url.query_pairs_mut().append_pair("propertyTypes", "flat,house");

            if let Some(min_price) = params.min_price {
                sold_url.query_pairs_mut().append_pair("minPrice", &min_price.to_string());
            }
            if let Some(max_price) = params.max_price {
                sold_url.query_pairs_mut().append_pair("maxPrice", &max_price.to_string());
            }

            return Ok(sold_url.to_string());
        }

        Ok(url.to_string())
    }

    async fn scrape_search_results_page(&self, url: &str) -> Result<Vec<ScrapedProperty>> {
        println!("Fetching: {}", url);

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
        println!("Page content length: {} characters", html.len());
        let document = Html::parse_document(&html);

        // Try multiple possible selectors for Rightmove properties
        let property_selectors = vec![
            ".l-searchResult",
            ".l-searchResults .propertyCard",
            "[data-test='property-card']",
            ".propertyCard-wrapper",
            ".propertyCard"
        ];

        let mut properties = Vec::new();
        let mut found_selector = None;

        for selector_str in &property_selectors {
            if let Ok(selector) = Selector::parse(selector_str) {
                let elements: Vec<_> = document.select(&selector).collect();
                if !elements.is_empty() {
                    println!("Found {} properties using selector: {}", elements.len(), selector_str);
                    found_selector = Some(selector_str);

                    for element in elements {
                        if let Ok(property) = self.extract_property_from_element(&element) {
                            properties.push(property);
                        }
                    }
                    break;
                }
            }
        }

        if found_selector.is_none() {
            println!("No properties found with any selector. Page might be blocked or structure changed.");
            // Safe string truncation that respects UTF-8 boundaries
            let preview_len = html.len().min(500);
            let safe_preview = if html.is_char_boundary(preview_len) {
                &html[..preview_len]
            } else {
                // Find the nearest char boundary before 500
                let mut safe_len = preview_len;
                while safe_len > 0 && !html.is_char_boundary(safe_len) {
                    safe_len -= 1;
                }
                &html[..safe_len]
            };
            println!("Page content preview: {}", safe_preview);
        }

        Ok(properties)
    }

    fn extract_property_from_element(&self, element: &scraper::ElementRef<'_>) -> Result<ScrapedProperty> {
        // Try multiple selectors for each field to handle different Rightmove layouts
        let address_selectors = vec![
            ".propertyCard-address",
            "[data-test='property-address']",
            ".propertyCard-details h2",
            "h2 a"
        ];

        let price_selectors = vec![
            ".propertyCard-priceValue",
            "[data-test='property-price']",
            ".propertyCard-price .price",
            ".price"
        ];

        let agent_selectors = vec![
            ".propertyCard-contactsItem-company",
            "[data-test='agent-name']",
            ".propertyCard-branchSummary-branchName"
        ];

        let link_selectors = vec![
            "a.propertyCard-link",
            "a[data-test='property-details']",
            "h2 a",
            "a"
        ];

        // Helper function to try multiple selectors
        let try_selectors = |selectors: &[&str], element: &scraper::ElementRef| -> String {
            for selector_str in selectors {
                if let Ok(selector) = Selector::parse(selector_str) {
                    if let Some(el) = element.select(&selector).next() {
                        let text = el.text().collect::<String>().trim().to_string();
                        if !text.is_empty() {
                            return text;
                        }
                    }
                }
            }
            String::new()
        };

        let try_link_selectors = |selectors: &[&str], element: &scraper::ElementRef| -> String {
            for selector_str in selectors {
                if let Ok(selector) = Selector::parse(selector_str) {
                    if let Some(el) = element.select(&selector).next() {
                        if let Some(href) = el.value().attr("href") {
                            return href.to_string();
                        }
                    }
                }
            }
            String::new()
        };

        let address = try_selectors(&address_selectors, element);
        let price_text = try_selectors(&price_selectors, element);
        let agent = try_selectors(&agent_selectors, element);
        let relative_url = try_link_selectors(&link_selectors, element);

        let price = self.parse_price(&price_text);

        // Ensure we have at least an address to make this a valid property
        if address.is_empty() {
            return Err(anyhow::anyhow!("No address found for property"));
        }

        let full_url = if relative_url.starts_with("http") {
            relative_url
        } else if relative_url.starts_with("/") {
            format!("https://www.rightmove.co.uk{}", relative_url)
        } else if !relative_url.is_empty() {
            format!("https://www.rightmove.co.uk/{}", relative_url)
        } else {
            String::new()
        };

        // Try to extract description from the property card
        let description_selectors = vec![
            ".propertyCard-description",
            ".propertyCard-summary",
            "[data-test='property-description']"
        ];
        let description = try_selectors(&description_selectors, element);

        println!("Extracted property: {} - {} - {}", address, price_text, agent);

        Ok(ScrapedProperty {
            url: full_url,
            address: self.clean_html(&address),
            price,
            property_type: "Property".to_string(),
            bedrooms: None,
            bathrooms: None,
            agent: self.clean_html(&agent),
            description: self.clean_html(&description),
            tenure: None,
            size_sqft: None,
            estimated_yield: None,
            sale_date: None,
        })
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

    fn matches_investment_keywords(&self, description: &str, keywords: &[String]) -> bool {
        if keywords.is_empty() {
            return true; // If no keywords specified, include all
        }

        let desc_lower = description.to_lowercase();
        keywords.iter().any(|keyword| {
            let keyword_lower = keyword.trim().to_lowercase();
            !keyword_lower.is_empty() && desc_lower.contains(&keyword_lower)
        })
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
        let document = Html::parse_document(&html);

        // Extract property details using multiple selectors for robustness
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

        // Parse extracted values
        let price = self.parse_price(&price_text);
        let bedrooms = self.parse_number(&bedrooms_text);
        let bathrooms = self.parse_number(&bathrooms_text);
        let size_sqft = self.parse_size(&size_text);

        println!("Extracted property details: {} - {} - {} - Agent: {}",
                 address, price_text, property_type, agent);

        if address.is_empty() {
            return Err(anyhow::anyhow!("Could not extract property address from page"));
        }

        Ok(ScrapedProperty {
            url: url.to_string(),
            address: self.clean_html(&address),
            price,
            property_type: if property_type.is_empty() { "Property".to_string() } else { self.clean_html(&property_type) },
            bedrooms,
            bathrooms,
            agent: self.clean_html(&agent),
            description: self.clean_html(&description),
            tenure: if tenure.is_empty() { None } else { Some(self.clean_html(&tenure)) },
            size_sqft,
            estimated_yield: None, // Will be calculated if needed
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