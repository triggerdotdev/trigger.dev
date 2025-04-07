import asyncio
import sys
from crawl4ai import AsyncWebCrawler
from crawl4ai.async_configs import BrowserConfig

async def main(url: str):
    # Get proxy configuration from environment variables
    browser_config = BrowserConfig(
        browser_type="chrome",
        headless=True,
        verbose=False,
    )

    async with AsyncWebCrawler(config=browser_config) as crawler:
        result = await crawler.arun(
            url=url,
        )
        print(result.markdown)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python crawler.py <url>")
        sys.exit(1)
    url = sys.argv[1]
    asyncio.run(main(url))