# Web Scraper CLI

CLI tool for scraping and downloading files from JavaScript-heavy pages using Puppeteer.

## Why?

Standard web fetching tools fail on Single Page Applications (SPAs) that require JavaScript to render content. This CLI uses Puppeteer (headless Chrome) to:

1. **Render JavaScript** - Loads the page in a real browser
2. **Capture authenticated URLs** - Intercepts network requests to find signed download URLs
3. **Extract files** - Finds PDFs, images, audio, and other downloadable content
4. **Download files** - Saves files with proper filenames

## Installation

```bash
cd ~/Documents/Dev/Dev-Tools/web-scraper-cli
uv sync
```

First run will automatically install Puppeteer dependencies.

## Usage

### Basic scraping (list files without downloading)

```bash
uv run webscrape scrape "https://taskcards.de/board/..."
```

### Download files

```bash
uv run webscrape scrape "https://example.com/page" --download
# or
uv run webscrape scrape "https://example.com/page" -d
```

### Custom output directory

```bash
uv run webscrape scrape "https://example.com" -d -o ~/Desktop/downloads
```

### Debug mode (shows browser window)

```bash
uv run webscrape scrape "https://example.com" --debug
```

### Check installation status

```bash
uv run webscrape info
```

### Install dependencies manually

```bash
uv run webscrape install
```

## Supported File Types

- **Documents**: PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX
- **Archives**: ZIP, RAR, 7Z, TAR, GZ
- **Images**: JPG, JPEG, PNG, GIF, WEBP, SVG, BMP
- **Audio/Video**: MP3, MP4, WAV, AVI, MOV, MKV
- **Data**: TXT, CSV, JSON, XML

## Output

By default, files are downloaded to `~/Downloads/web-scraper/`.

Each scrape also produces:
- `page-screenshot.png` - Full page screenshot
- `scrape-results.json` - Structured data about found content

## Supported Sites

Works with any JavaScript-rendered site. Tested with:
- Notion (public pages)
- Airtable (public views)
- Other SPAs with embedded files

### TaskCards Limitation

**Known Issue**: TaskCards serves JPEG preview thumbnails instead of actual PDF files at their S3 URLs. This is a platform limitation, not a bug in this scraper.

The scraper will:
1. Detect when downloaded files don't match their expected type (e.g., PDF file that's actually JPEG)
2. Save files with their **correct extension** (e.g., `.jpg` for JPEG images)
3. Report which files are actual documents vs preview thumbnails

**Workaround**: For TaskCards PDFs, download manually from the website by clicking on each file.

## Requirements

- Python 3.11+
- Node.js 18+
- uv (Python package manager)

## Architecture

```
web-scraper-cli/
├── pyproject.toml          # Python CLI config
├── web_scraper_cli/        # Python CLI package
│   ├── __init__.py
│   └── main.py             # Click CLI entry point
└── scraper/                # Node.js Puppeteer scraper
    ├── package.json
    └── scraper.js          # Core scraping logic
```

The Python CLI wraps the Node.js Puppeteer scraper, providing a consistent interface with other Dev-Tools CLIs.
