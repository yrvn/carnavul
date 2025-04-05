Okay, here is a README file based on the project structure and code provided.

````markdown name=README.md
# Carnavul Downloader

Carnavul Downloader is a Node.js command-line tool designed to download Uruguayan Carnival performance videos from YouTube, automatically organize them into folders by year and category, and generate `.nfo` metadata files compatible with media centers like Kodi.

It leverages `yt-dlp` for the actual downloading and relies on a configurable JSON file (`conjuntos.json`) to identify carnival groups ("conjuntos") and their categories within video titles.

## Features

- **Download Videos:** Downloads videos from specified YouTube channels or individual video URLs.
- **Automatic Organization:** Creates a directory structure based on performance year and category (e.g., `downloads/2023/Murgas/`).
- **Title Parsing:** Attempts to parse video titles to identify the carnival group (conjunto), year, and performance round (e.g., "Primera Rueda", "Liguilla").
- **NFO File Generation:** Creates `.nfo` metadata files for each downloaded video, including title, original title, year, genre (category/round), plot (from video description), and YouTube ID.
- **Download Tracking:** Uses `yt-dlp`'s download archive (`.tracking/downloaded.txt`) to avoid re-downloading videos.
- **State Management:** Tracks videos that couldn't be parsed (`ignored.json`), failed downloads (`failed.json`), and videos needing manual review (`check_later.json`).
- **Configurable:** Uses `conjuntos.json` to define known carnival groups and their categories.
- **Flexible Filtering:** Implements basic logic to skip short videos or those identified as "resumen" (summaries), while allowing exceptions (e.g., "fragmento" before 2005).
- **Check Later Workflow:** Allows manually reviewing videos in `check_later.json`, adding a `download: true` flag, and re-processing them.

## Prerequisites

- **Node.js:** Version 14.0.0 or higher.
- **npm** or **yarn:** Package manager for Node.js.
- **yt-dlp:** The core video downloading utility. It must be installed and accessible in your system's PATH. You can find installation instructions here: [yt-dlp GitHub](https://github.com/yt-dlp/yt-dlp#installation)

## Installation

1.  **Clone the repository (or download the files):**
    ```bash
    git clone <repository-url>
    cd carnavul-downloader # Or your project directory name
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    # or
    yarn install
    ```

## Configuration (`conjuntos.json`)

The `conjuntos.json` file is crucial for identifying carnival groups within video titles. It's a JSON object where keys are category names (e.g., "Murgas", "Lubolos") and values are arrays of strings containing the known names of groups in that category.

```json name=conjuntos.json
{
  "Lubolos": [
    "C 1080",
    "Yambo Kenia",
    "Tronar De Tambores"
    // ... other Lubolos groups
  ],
  "Murgas": [
    "Agarrate Catalina",
    "Asaltantes Con Patente",
    "Cayó La Cabra",
    "La Gran Muñeca"
    // ... other Murgas groups
  ],
  "Humoristas": [
    "Sociedad Anónima",
    "Los Choby's"
    // ... other Humoristas groups
  ],
  "Parodistas": [
    "Zíngaros",
    "Nazarenos",
    "Momosapiens"
    // ... other Parodistas groups
  ],
  "Revistas": [
    "Tabú",
    "La Compañía"
    // ... other Revistas groups
  ]
}
```
````

The tool uses fuzzy string matching (Levenshtein distance) to compare names found in video titles against this list. Ensure the names are accurate.

## Usage

The tool is run from the command line using `node src/cli.js` or, if you link it globally (`npm link`), just `carnavul`.

```bash
node src/cli.js [options]
```

**Options:**

- `-c, --channel <url>`: Process a YouTube channel URL. The tool will fetch all videos from the channel (oldest first) and process them.
- `-v, --video <url>`: Process a single YouTube video URL.
- `--check-later`: Process videos listed in `.tracking/check_later.json` that have been manually marked with `"download": true`.
- `-d, --dir <path>`: Base directory for downloads and tracking files. Defaults to the current directory (`.`). Downloads will be placed in subdirectories like `<dir>/<year>/<category>/`. The `.tracking` folder will also be created here.
- `--config <path>`: Path to the `conjuntos.json` configuration file. Defaults to `conjuntos.json` in the current directory.
- `--log-level <level>`: Set logging level (e.g., `info`, `debug`, `error`). Defaults to `info`. Logs are printed to the console and saved to `combined.log` and `error.log`.
- `-h, --help`: Display help information.
- `--version`: Display the version number.

**Examples:**

- **Download all videos from a channel:**
  ```bash
  node src/cli.js -c "https://www.youtube.com/channel/UC..." -d ./carnival_downloads
  ```
- **Download a single video:**
  ```bash
  node src/cli.js -v "https://www.youtube.com/watch?v=..." -d ./carnival_downloads
  ```
- **Process videos marked for checking later:**
  ```bash
  node src/cli.js --check-later -d ./carnival_downloads
  ```
- **Use a specific config file and increase log verbosity:**
  ```bash
  node src/cli.js -c "https://www.youtube.com/channel/UC..." --config /path/to/my_conjuntos.json --log-level debug
  ```

## Output Structure

Downloaded videos and their metadata are organized as follows:

```
<base_directory>/
├── .tracking/          # Internal tracking files (see below)
├── <year>/             # e.g., 2023
│   ├── <category>/     # e.g., Murgas
│   │   ├── <Conjunto Name> <Year>.mp4
│   │   ├── <Conjunto Name> <Year>.nfo
│   │   ├── <Conjunto Name> <Year> - <Round>.mp4
│   │   └── <Conjunto Name> <Year> - <Round>.nfo
│   └── <category>/     # e.g., Parodistas
│       └── ...
└── <year>/             # e.g., 2022
    └── ...
```

- `<base_directory>`: The directory specified with the `-d` option (or the current directory).
- `<year>`: The year parsed from the video title.
- `<category>`: The category associated with the identified conjunto (from `conjuntos.json`).
- `<Conjunto Name>`: The name of the carnival group.
- `<Round>`: The performance round (e.g., "Primera Rueda", "Liguilla"), if identified.

## Tracking Files (`.tracking/`)

The `.tracking` directory is automatically created in the base directory and contains files used to manage the download process:

- `downloaded.txt`: The download archive used by `yt-dlp`. It lists the IDs of videos that have been successfully processed (downloaded or skipped because they were already present). Format: `<extractor> <video_id>`.
- `check_later.json`: A JSON array of videos that were skipped due to duration constraints, containing "resumen", or other filter criteria. You can manually review this file, add `"download": true` to entries you want to download anyway, and then run the tool with the `--check-later` flag.
- `ignored.json`: A JSON array of videos that were skipped because the tool could not parse a year or identify a known conjunto from the title according to the `conjuntos.json` configuration.
- `failed.json`: A JSON array logging videos that failed during the download or processing stage, including the error message.
- `incomplete.json`: (Currently less used, might be merged with `check_later`) Potentially logs items that couldn't be fully processed for other reasons.

## License

This project is licensed under the ISC License. See the `package.json` file for details.

```

```
