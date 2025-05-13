import html2text
import requests
import argparse
import sys

def fetch_html(url):
    """Fetch HTML content from a URL."""
    try:
        response = requests.get(url)
        response.raise_for_status()  # Raise an exception for HTTP errors
        return response.text
    except requests.exceptions.RequestException as e:
        print(f"Error fetching URL: {e}", file=sys.stderr)
        sys.exit(1)

def main():
    # Set up command line argument parsing
    parser = argparse.ArgumentParser(description='Convert HTML from a URL to plain text.')
    parser.add_argument('url', help='The URL to fetch HTML from')
    parser.add_argument('--ignore-links', action='store_true', 
                        help='Ignore converting links from HTML')
    
    args = parser.parse_args()
    
    # Fetch HTML from the URL
    html_content = fetch_html(args.url)
    
    # Configure html2text
    h = html2text.HTML2Text()
    h.ignore_links = args.ignore_links
    
    # Convert HTML to text and print
    text_content = h.handle(html_content)
    print(text_content)

if __name__ == "__main__":
    main()
