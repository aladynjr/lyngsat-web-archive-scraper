# Lyngsat Web Archive Scraper

This Node.js project scrapes historical satellite TV channel data from archived versions of Lyngsat.com using the Wayback Machine. It extracts information about TV channels, their properties, and organizes the data by region and country.

**Note:** This scraper was developed for a specific client's needs. You may need to adjust the code to fit your particular use case or to accommodate changes in the website structure over time.

## Features

- Fetches archived URLs of Lyngsat.com from the Wayback Machine
- Extracts Free TV links for each archived snapshot
- Scrapes region and country links
- Gathers detailed channel information for each country
- Handles pagination and nested data structures
- Implements error handling and retries
- Saves data in JSON format

## Prerequisites

- Node.js (version 12 or higher recommended)
- npm (comes with Node.js)

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/your-username/lyngsat-web-archive-scraper.git
   ```

2. Navigate to the project directory:
   ```
   cd lyngsat-web-archive-scraper
   ```

3. Install dependencies:
   ```
   npm install
   ```

4. Create a `.env` file in the root directory and add your Geonode proxy credentials:
   ```
   GEONODE_USERNAME=your_username
   GEONODE_PASSWORD=your_password
   GEONODE_DNS=your_geonode_dns
   ```

## Usage

Run the main script:

```
node index.js
```

The script will:
1. Fetch archived URLs if not already present
2. Process each archived snapshot
3. Extract channel data for each country
4. Save the results in JSON files in the `data` directory

## Output

The scraped data is saved in JSON files named in the format `YYYY-MMM_YYYYMMDDHHMMSS.json` in the `data` directory. Each file contains information about TV channels organized by region and country for a specific archived snapshot.

## Limitations

- The script uses a proxy service (Geonode) to avoid IP blocking. Ensure you have a valid subscription.
- Scraping large amounts of data may take considerable time and resources.
- The structure of Lyngsat.com may change over time, potentially requiring updates to the scraping logic.
- This scraper was built for specific client needs and may require modifications for different use cases.

## Customization

You may need to adjust the following aspects of the scraper:
- The date range for archived snapshots
- The specific data fields being extracted
- The output format and structure
- Error handling and retry mechanisms

## Contributing

While this project was created for specific client needs, contributions are welcome if you find ways to improve or expand its functionality. Please open an issue first to discuss what you would like to change or add.

## License

[MIT](https://choosealicense.com/licenses/mit/)
