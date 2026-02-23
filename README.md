# LASO Search

A beautiful, interactive web application that lets you draw custom shapes on a map and discover all the restaurants, businesses, and points of interest within your selected area.

## Features

- **Interactive Map Drawing**: Toggle drawing mode to create custom polygons on the map
- **Smart Polygon Closing**: Automatically closes polygons when you click near the starting point or double-click
- **Business Discovery**: Search for restaurants, cafes, bars, shops, and stores within your drawn area
- **Advanced Geolocation**: Intelligent bounds evaluation and center-point calculations
- **Beautiful UI**: Modern, responsive design with smooth animations and intuitive controls
- **100% Free**: Uses OpenStreetMap - NO API KEY, NO ACCOUNT, NO CREDIT CARD required

## Why OpenStreetMap?

- **Completely FREE** - No usage limits, no quotas, no billing
- **NO API KEY required** - Just works out of the box
- **NO ACCOUNT needed** - No signup, no registration
- **NO CREDIT CARD ever** - Zero risk of being charged
- **Open Source** - Community-driven, transparent
- **High Quality Maps** - Detailed global coverage

## Prerequisites

- **Node.js**: For running the start script (optional, you can also just open index.html directly)

That's it! No API keys, no accounts, no configuration needed.

## Setup

### Option 1: Run with the start script

```bash
./get-api-key.sh
```

This will:
- Generate `index.html` from the template
- Start a local Python HTTP server on port 8080
- Open your browser to `http://localhost:8080`

### Option 2: Just open the file directly

Since no API key is needed, you can simply open `index.template.html` directly in your browser:

```bash
# On macOS
open index.template.html

# On Linux
xdg-open index.template.html

# Or just double-click the file in your file manager
```

## How to Use

1. **Search for a Location**: Enter an address in the search bar to center the map

2. **Draw a Shape**:
   - Click the "Draw" button to enter drawing mode
   - Click on the map to add points to your polygon
   - Click near the starting point or double-click to close the shape
   - Click "Cancel" to exit drawing mode without saving

3. **Find Businesses**:
   - After drawing your shape, click "LASO Search"
   - View all restaurants, cafes, bars, and shops within your area
   - Click on results to see details and highlight locations on the map

4. **Clear**: Click the trash icon to clear your polygon and start over

## Project Structure

```
.
├── index.template.html    # Main HTML file (no API key needed!)
├── index.html              # Generated HTML (do not commit)
├── app.js                  # Main application logic (Leaflet + OpenStreetMap)
├── styles.css              # Modern UI styles
├── get-api-key.sh          # Start script (no API key needed)
└── .gitignore              # Git ignore file
```

## Browser Support

- Chrome (recommended)
- Firefox
- Safari
- Edge

## Technologies

- **Leaflet.js** - Open source interactive maps library
- **OpenStreetMap** - Free, community-driven map tiles
- **Overpass API** - Free POI and business search
- **Nominatim** - Free geocoding service
- **Vanilla JavaScript (ES6+)** - Modern JavaScript with async/await
- **CSS3** - Modern styling with custom properties
- **Responsive Design** - Works on desktop and mobile

## Important: Fair Use

OpenStreetMap's tile servers are generously provided for free. Please be respectful:

- Don't hammer the servers with excessive requests
- Cache results when possible
- For high-traffic production apps, consider [donating to OSM](https://www.openstreetmap.org/donate) or hosting your own tile server

For personal projects and low-to-moderate traffic, the free tiles are more than sufficient!

## License

MIT License

## Support

For issues or feature requests, please open an issue on the project repository.

---

**Enjoy completely free mapping! 🗺️ No strings attached.**
