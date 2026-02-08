"""Web Scraper CLI - Main entry point."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import click
from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.table import Table
from rich.tree import Tree

from . import __version__

console = Console()

SCRAPER_DIR = Path(__file__).parent.parent / "scraper"
DEFAULT_OUTPUT_DIR = Path.home() / "Downloads" / "web-scraper"


class ScraperError(RuntimeError):
    """Raised when the scraper subprocess fails or returns no results."""


def check_node_installed() -> bool:
    """Check if Node.js is installed."""
    return shutil.which("node") is not None


def check_npm_dependencies() -> bool:
    """Check if npm dependencies are installed."""
    node_modules = SCRAPER_DIR / "node_modules"
    return node_modules.exists() and (node_modules / "puppeteer").exists()


def install_npm_dependencies() -> None:
    """Install npm dependencies.

    Raises:
        ScraperError: If npm install fails.
    """
    console.print("[yellow]Installing Puppeteer dependencies...[/yellow]")
    try:
        result = subprocess.run(
            ["npm", "install"],
            cwd=SCRAPER_DIR,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as e:
        raise ScraperError(f"npm not found: {e}")

    if result.returncode != 0:
        raise ScraperError(f"npm install failed: {result.stderr}")


def run_scraper(url: str, download: bool, debug: bool, output_dir: Path) -> dict:
    """Run the Puppeteer scraper and return results.

    Raises:
        ScraperError: If the scraper fails, times out, or produces no results.
    """
    env = {
        **os.environ,
        **({"DOWNLOAD": "true"} if download else {}),
        **({"DEBUG": "true"} if debug else {}),
    }

    scraper_path = SCRAPER_DIR / "scraper.js"

    try:
        result = subprocess.run(
            ["node", str(scraper_path), url],
            cwd=SCRAPER_DIR,
            capture_output=True,
            text=True,
            env=env,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        raise ScraperError("Scraper timed out after 5 minutes")
    except FileNotFoundError as e:
        raise ScraperError(f"Node.js not found: {e}")

    if result.returncode != 0:
        raise ScraperError(f"Scraper error:\n{result.stderr}")

    results_file = SCRAPER_DIR / "downloads" / "scrape-results.json"
    if not results_file.exists():
        raise ScraperError("Scraper produced no results file")

    try:
        data = json.loads(results_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ScraperError(f"Invalid scraper output: {e}")

    if download:
        move_downloads_to_output(output_dir)

    return data


def move_downloads_to_output(output_dir: Path) -> list[Path]:
    """Move downloaded files from scraper directory to output directory."""
    source_dir = SCRAPER_DIR / "downloads"
    output_dir.mkdir(parents=True, exist_ok=True)

    skip = {"scrape-results.json", "page-screenshot.png"}
    moved_files = []
    for file in source_dir.iterdir():
        if file.name in skip or not file.is_file():
            continue
        dest = output_dir / file.name
        shutil.move(file, dest)
        moved_files.append(dest)

    return moved_files


def display_results(data: dict, output_dir: Path, downloaded: bool) -> None:
    """Display scrape results using Rich."""
    console.print()
    console.print(Panel(f"[bold]{data.get('title', 'Unknown Page')}[/bold]", style="blue"))

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

    if files:
        tree = Tree("[bold]Downloadable Files[/bold]")
        for f in files:
            tree.add(f"[green]{f.get('name', 'unknown')}[/green]")
        console.print(tree)
        console.print()

    if downloaded and files:
        console.print(f"[green]✓[/green] Files downloaded to: [cyan]{output_dir}[/cyan]")
    elif files:
        console.print("[yellow]Tip:[/yellow] Use [cyan]--download[/cyan] to download files")


@click.group()
@click.version_option(version=__version__)
def cli() -> None:
    """Web Scraper CLI - Download files from JavaScript-heavy pages.

    Uses Puppeteer to render JavaScript and extract downloadable files
    from single-page applications (SPAs) like TaskCards, Notion, etc.
    """


@cli.command()
@click.argument("url")
@click.option(
    "-d", "--download",
    is_flag=True,
    help="Download found files",
)
@click.option(
    "-o", "--output",
    type=click.Path(path_type=Path),
    default=DEFAULT_OUTPUT_DIR,
    help=f"Output directory for downloads (default: {DEFAULT_OUTPUT_DIR})",
)
@click.option(
    "--debug",
    is_flag=True,
    help="Show browser window for debugging",
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
    if not url.startswith(("http://", "https://")):
        raise click.ClickException("URL must start with http:// or https://")

    if not check_node_installed():
        raise click.ClickException("Node.js is not installed. Please install Node.js first.")

    if not check_npm_dependencies():
        try:
            install_npm_dependencies()
        except ScraperError as e:
            raise click.ClickException(str(e))

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        console=console,
    ) as progress:
        progress.add_task("Scraping page...", total=None)
        try:
            data = run_scraper(url, download, debug, output)
        except ScraperError as e:
            raise click.ClickException(str(e))

    display_results(data, output, download)


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

    console.print("[bold]Supported file types:[/bold]")
    console.print("PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, ZIP, RAR, 7Z, TAR, GZ")
    console.print("JPG, JPEG, PNG, GIF, WEBP, SVG, BMP")
    console.print("MP3, MP4, WAV, AVI, MOV, MKV")
    console.print("TXT, CSV, JSON, XML")


@cli.command()
def install() -> None:
    """Install Puppeteer dependencies."""
    if not check_node_installed():
        raise click.ClickException("Node.js is not installed. Please install Node.js first.")

    if check_npm_dependencies():
        console.print("[green]Dependencies are already installed.[/green]")
        return

    try:
        install_npm_dependencies()
    except ScraperError as e:
        raise click.ClickException(str(e))

    console.print("[green]✓ Dependencies installed successfully![/green]")


if __name__ == "__main__":
    cli()
