const fs = require('fs');
const path = require('path');

// Read environment variables
const apiKey = process.env.GOOGLE_MAPS_API_KEY;
const region = process.env.GOOGLE_MAPS_REGION || 'us';
const language = process.env.GOOGLE_MAPS_LANGUAGE || 'en';

if (!apiKey || apiKey === 'YOUR_API_KEY_HERE') {
    console.error('Error: GOOGLE_MAPS_API_KEY not set or invalid');
    process.exit(1);
}

// Read the HTML template
const templatePath = path.join(__dirname, 'index.template.html');
const outputPath = path.join(__dirname, 'index.html');

if (!fs.existsSync(templatePath)) {
    console.error('Error: index.template.html not found');
    process.exit(1);
}

let html = fs.readFileSync(templatePath, 'utf8');

// Replace placeholders
html = html.replace(/\{\{GOOGLE_MAPS_API_KEY\}\}/g, apiKey);
html = html.replace(/\{\{GOOGLE_MAPS_REGION\}\}/g, region);
html = html.replace(/\{\{GOOGLE_MAPS_LANGUAGE\}\}/g, language);

// Write the output
fs.writeFileSync(outputPath, html);
console.log('API key injected successfully into index.html');
