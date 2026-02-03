"""Web Scraper CLI - Main entry point."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import click
from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.table import Table
from rich.tree import Tree

console = Console()

# Get the scraper directory (relative to this module)
SCRAPER_DIR = Path(__file__).parent.parent / "scraper"
DEFAULT_OUTPUT_DIR = Path.home() / "Downloads" / "web-scraper"


def check_node_installed() -> bool:
    """Check if Node.js is installed."""
    return shutil.which("node") is not None


def check_npm_dependencies() -> bool:
    """Check if npm dependencies are installed."""
    node_modules = SCRAPER_DIR / "node_modules"
    return node_modules.exists() and (node_modules / "puppeteer").exists()


def install_npm_dependencies() -> bool:
    """Install npm dependencies."""
    console.print("[yellow]Installing Puppeteer dependencies...[/yellow]")
    try:
        result = subprocess.run(
            ["npm", "install"],
            cwd=SCRAPER_DIR,
            capture_output=True,
            text=True,
        )
        return result.returncode == 0
    except Exception as e:
        console.print(f"[red]Failed to install dependencies: {e}[/red]")
        return False


def run_scraper(url: str, download: bool, debug: bool, output_dir: Path) -> dict | None:
    """Run the Puppeteer scraper and return results."""
    env = os.environ.copy()
    if download:
        env["DOWNLOAD"] = "true"
    if debug:
        env["DEBUG"] = "true"

    # Update scraper config to use custom output directory
    scraper_path = SCRAPER_DIR / "scraper.js"

    try:
        result = subprocess.run(
            ["node", str(scraper_path), url],
            cwd=SCRAPER_DIR,
            capture_output=True,
            text=True,
            env=env,
            timeout=300,  # 5 minute timeout
        )

        if result.returncode != 0:
            console.print(f"[red]Scraper error:[/red]\n{result.stderr}")
            return None

        # Parse results from JSON file
        results_file = SCRAPER_DIR / "downloads" / "scrape-results.json"
        if results_file.exists():
            with open(results_file) as f:
                data = json.load(f)

            # Move files to output directory if downloading
            if download:
                move_downloads_to_output(output_dir)

            return data

        return None

    except subprocess.TimeoutExpired:
        console.print("[red]Scraper timed out after 5 minutes[/red]")
        return None
    except Exception as e:
        console.print(f"[red]Error running scraper: {e}[/red]")
        return None


def move_downloads_to_output(output_dir: Path) -> list[Path]:
    """Move downloaded files from scraper directory to output directory."""
    source_dir = SCRAPER_DIR / "downloads"
    output_dir.mkdir(parents=True, exist_ok=True)

    moved_files = []
    for file in source_dir.iterdir():
        if file.name in ("scrape-results.json", "page-screenshot.png"):
            continue
        if file.is_file():
            dest = output_dir / file.name
            shutil.move(str(file), str(dest))
            moved_files.append(dest)

    return moved_files


def display_results(data: dict, output_dir: Path, downloaded: bool) -> None:
    """Display scrape results using Rich."""
    # Title
    console.print()
    console.print(Panel(f"[bold]{data.get('title', 'Unknown Page')}[/bold]", style="blue"))

    # Summary table
    table = Table(show_header=False, box=None)
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="green")

    cards = data.get("cards", [])
    files = data.get("files", [])
    images = data.get("images", [])
    links = data.get("links", [])

    if cards:
        table.add_row("Cards found", str(len(cards)))
    table.add_row("Files found", str(len(files)))
    table.add_row("Images found", str(len(images)))
    table.add_row("Links found", str(len(links)))

    console.print(table)
    console.print()

    # Files list
    if files:
        tree = Tree("[bold]Downloadable Files[/bold]")
        for f in files:
            name = f.get("name", "unknown")
            tree.add(f"[green]{name}[/green]")
        console.print(tree)
        console.print()

    # Download status
    if downloaded and files:
        console.print(f"[green]✓[/green] Files downloaded to: [cyan]{output_dir}[/cyan]")
    elif files:
        console.print("[yellow]Tip:[/yellow] Use [cyan]--download[/cyan] to download files")


@click.group()
@click.version_option(version="1.0.0")
def cli() -> None:
    """Web Scraper CLI - Download files from JavaScript-heavy pages.

    Uses Puppeteer to render JavaScript and extract downloadable files
    from single-page applications (SPAs) like TaskCards, Notion, etc.
    """
    pass


@cli.command()
@click.argument("url")
@click.option(
    "-d", "--download",
    is_flag=True,
    help="Download found files"
)
@click.option(
    "-o", "--output",
    type=click.Path(path_type=Path),
    default=DEFAULT_OUTPUT_DIR,
    help=f"Output directory for downloads (default: {DEFAULT_OUTPUT_DIR})"
)
@click.option(
    "--debug",
    is_flag=True,
    help="Show browser window for debugging"
)
def scrape(url: str, download: bool, output: Path, debug: bool) -> None:
    """Scrape a URL and optionally download files.

    URL: The webpage URL to scrape (must include http:// or https://)

    \b
    Examples:
        webscrape scrape "https://taskcards.de/board/..."
        webscrape scrape "https://example.com" --download
        webscrape scrape "https://example.com" -d -o ~/Desktop/files
    """
    # Validate URL
    if not url.startswith(("http://", "https://")):
        console.print("[red]Error:[/red] URL must start with http:// or https://")
        sys.exit(1)

    # Check Node.js
    if not check_node_installed():
        console.print("[red]Error:[/red] Node.js is not installed. Please install Node.js first.")
        sys.exit(1)

    # Check/install dependencies
    if not check_npm_dependencies():
        if not install_npm_dependencies():
            console.print("[red]Error:[/red] Failed to install npm dependencies.")
            sys.exit(1)

    # Run scraper with progress
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        console=console,
    ) as progress:
        task = progress.add_task("Scraping page...", total=None)
        data = run_scraper(url, download, debug, output)

    if data:
        display_results(data, output, download)
    else:
        console.print("[red]Failed to scrape the page[/red]")
        sys.exit(1)


@cli.command()
def info() -> None:
    """Show information about the scraper setup."""
    console.print()
    console.print(Panel("[bold]Web Scraper CLI Info[/bold]", style="blue"))

    table = Table(show_header=False, box=None)
    table.add_column("Setting", style="cyan")
    table.add_column("Value")

    table.add_row("Scraper directory", str(SCRAPER_DIR))
    table.add_row("Default output", str(DEFAULT_OUTPUT_DIR))
    table.add_row("Node.js installed", "✓" if check_node_installed() else "✗")
    table.add_row("Dependencies installed", "✓" if check_npm_dependencies() else "✗")

    console.print(table)
    console.print()

    # Supported file types
    console.print("[bold]Supported file types:[/bold]")
    console.print("PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, ZIP, RAR, 7Z, TAR, GZ")
    console.print("JPG, JPEG, PNG, GIF, WEBP, SVG, BMP")
    console.print("MP3, MP4, WAV, AVI, MOV, MKV")
    console.print("TXT, CSV, JSON, XML")


@cli.command()
def install() -> None:
    """Install Puppeteer dependencies."""
    if not check_node_installed():
        console.print("[red]Error:[/red] Node.js is not installed. Please install Node.js first.")
        sys.exit(1)

    if check_npm_dependencies():
        console.print("[green]Dependencies are already installed.[/green]")
        return

    if install_npm_dependencies():
        console.print("[green]✓ Dependencies installed successfully![/green]")
    else:
        console.print("[red]Failed to install dependencies[/red]")
        sys.exit(1)


if __name__ == "__main__":
    cli()
