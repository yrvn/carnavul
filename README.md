# Carnavul Downloader

A Node.js script for downloading and organizing carnival performance videos from YouTube channels using yt-dlp.

## Prerequisites

- Node.js 16.x or higher
- yt-dlp installed on your system ([Installation Guide](https://github.com/yt-dlp/yt-dlp#installation))

## Installation

1. Clone the repository:

```bash
git clone https://github.com/yourusername/carnavul-downloader.git
cd carnavul-downloader
```

2. Install dependencies:

```bash
npm install
```

## Usage

Run the script with the following command:

```bash
node src/index.js -c "CHANNEL_URL" -d "OUTPUT_DIRECTORY" [-t "TRACKING_FILES_PATH"]
```

### Parameters

- `-c, --channel`: YouTube channel URL (required)
- `-d, --directory`: Base directory for downloads (required)
- `-t, --tracking`: Override path for tracking files (optional)

### Example

```bash
node src/index.js -c "https://www.youtube.com/@CarnavalChannel" -d "/media/carnival/videos"
```

## File Structure

The downloaded videos will be organized in the following structure:

```
/base_directory
  /year
    /category
      /[conjunto_name] - [year][title].[extension]
  /.tracking
    downloaded.txt
    check_later.json
    ignored.json
    failed.json
  download_report.json
```

## Download Rules

Videos must meet the following criteria to be downloaded:

1. Minimum duration: 30 minutes
2. Must match one of these conditions:
   - Contains "actuacion completa"
   - Contains "fragmento" AND year < 2005
3. Will be skipped if:
   - Contains "RESUMEN"
   - Cannot identify conjunto name or year
   - Does not meet above conditions (added to check_later.json)

## Tracking Files

- `downloaded.txt`: Archive of successfully downloaded videos
- `check_later.json`: Videos that need manual review
- `ignored.json`: Videos that don't match required patterns
- `failed.json`: Videos that failed to download

## Reports

After processing, a `download_report.json` file is generated with:

- Number of videos downloaded
- Number of videos in check_later
- Number of ignored videos
- Number of failed downloads
- Distribution by category
- Total processing time
- Timestamp

## Error Handling

- All errors are logged to `error.log`
- Combined logs are available in `combined.log`
- Failed downloads are tracked in `failed.json` with error details

## Contributing

Feel free to submit issues and enhancement requests!
