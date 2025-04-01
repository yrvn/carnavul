import { Command } from "commander";
import { createLogger, format, transports } from "winston";
import fs from "fs-extra";
import path from "path";
import youtubeDl from "youtube-dl-exec";
import dayjs from "dayjs";
import { execSync } from "child_process";

// Configure logger with console formatting
const logger = createLogger({
  format: format.combine(format.timestamp(), format.json()),
  transports: [
    new transports.File({ filename: "error.log", level: "error" }),
    new transports.File({ filename: "combined.log" }),
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.timestamp(),
        format.printf(({ level, message, timestamp }) => {
          return `${timestamp} ${level}: ${message}`;
        })
      ),
    }),
  ],
});

// Generate NFO file content
const generateNfoContent = (videoInfo, conjunto, year) => {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
    <title>${conjunto.name} ${year}</title>
    <originaltitle>${videoInfo.title}</originaltitle>
    <sorttitle>${conjunto.name} ${year}</sorttitle>
    <year>${year}</year>
    <genre>Carnival</genre>
    <genre>${conjunto.category}</genre>
    <plot>${videoInfo.description || ""}</plot>
    <source>YouTube</source>
    <dateadded>${new Date().toISOString()}</dateadded>
</movie>`;
};

// Load configuration
const loadConfig = async () => {
  try {
    logger.info("Loading conjuntos.json configuration...");
    const conjuntos = await fs.readJson(
      path.join(process.cwd(), "conjuntos.json")
    );
    logger.info(
      `Configuration loaded successfully. Found ${
        Object.keys(conjuntos).length
      } categories`
    );
    return conjuntos;
  } catch (error) {
    logger.error("Failed to load conjuntos.json", { error: error.message });
    throw new Error("Configuration loading failed");
  }
};

// Initialize tracking files
const initTrackingFiles = async (baseDir) => {
  logger.info("Initializing tracking files...");
  const trackingDir = path.join(baseDir, ".tracking");
  await fs.ensureDir(trackingDir);
  logger.info(`Created tracking directory at ${trackingDir}`);

  const files = {
    downloaded: path.join(trackingDir, "downloaded.txt"),
    checkLater: path.join(trackingDir, "check_later.json"),
    ignored: path.join(trackingDir, "ignored.json"),
    failed: path.join(trackingDir, "failed.json"),
  };

  for (const [key, filePath] of Object.entries(files)) {
    if (key === "downloaded") {
      await fs.ensureFile(filePath);
    } else {
      await fs.ensureFile(filePath);
      const exists = await fs.pathExists(filePath);
      if (!exists || (await fs.stat(filePath)).size === 0) {
        await fs.writeJson(filePath, []);
      }
    }
    logger.info(`Initialized ${key} tracking file at ${filePath}`);
  }

  return files;
};

// String normalization helper
const normalizeString = (str) => {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/['\s]/g, "") // remove spaces and apostrophes
    .replace(/[^a-z0-9]/g, ""); // remove other special chars
};

// Calculate string similarity (Levenshtein-based)
const calculateSimilarity = (str1, str2) => {
  const s1 = normalizeString(str1);
  const s2 = normalizeString(str2);

  // First check for exact inclusion
  if (s1.includes(s2) || s2.includes(s1)) {
    return 1;
  }

  // Calculate Levenshtein distance
  const matrix = [];
  let i, j;

  for (i = 0; i <= s1.length; i++) {
    matrix[i] = [i];
  }

  for (j = 0; j <= s2.length; j++) {
    matrix[0][j] = j;
  }

  for (i = 1; i <= s1.length; i++) {
    for (j = 1; j <= s2.length; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  const distance = matrix[s1.length][s2.length];
  const maxLength = Math.max(s1.length, s2.length);
  return (maxLength - distance) / maxLength;
};

// Parse video title to extract year and conjunto name
const parseVideoTitle = (title, conjuntos) => {
  logger.info(`Parsing video title: ${title}`);

  // Extract year (19XX or 20XX)
  const yearMatch = title.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? yearMatch[0] : null;

  if (!year) {
    logger.info("No year found in title");
  } else {
    logger.info(`Found year: ${year}`);
  }

  // Find conjunto name with improved matching
  let foundConjunto = null;
  let bestMatchScore = 0;

  for (const [category, groupList] of Object.entries(conjuntos)) {
    for (const conjunto of groupList) {
      const similarity = calculateSimilarity(title, conjunto);

      if (similarity > 0.85 && similarity > bestMatchScore) {
        foundConjunto = {
          name: conjunto,
          category,
          similarity,
        };
        bestMatchScore = similarity;
      }
    }
  }

  if (foundConjunto) {
    logger.info(
      `Found conjunto: ${foundConjunto.name} in category: ${
        foundConjunto.category
      } (similarity: ${foundConjunto.similarity.toFixed(2)})`
    );
  } else {
    logger.info("No conjunto found in title");
  }

  return { year, conjunto: foundConjunto };
};

// Check if video meets download criteria
const shouldDownload = (videoInfo) => {
  const { title, duration } = videoInfo;
  logger.info(`Checking download criteria for video: ${title}`);
  logger.info(`Video duration: ${duration} seconds`);

  const durationMinutes = parseInt(duration) / 60;

  if (durationMinutes < 30) {
    logger.info("Video too short, skipping");
    return false;
  }

  const hasActuacionCompleta = title
    .toLowerCase()
    .includes("actuacion completa");
  const hasFragmento = title.toLowerCase().includes("fragmento");
  const hasResumen = title.toLowerCase().includes("resumen");

  logger.info(
    `Title conditions: actuacion completa: ${hasActuacionCompleta}, fragmento: ${hasFragmento}, resumen: ${hasResumen}`
  );

  const yearMatch = title.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? parseInt(yearMatch[0]) : null;

  if (hasResumen) {
    logger.info("Video is a resumen, skipping");
    return false;
  }
  if (hasActuacionCompleta) {
    logger.info("Video is actuacion completa, will download");
    return true;
  }
  if (hasFragmento && year && year < 2005) {
    logger.info("Video is fragmento before 2005, will download");
    return true;
  }

  logger.info("Video does not meet download criteria");
  return false;
};

// Add this helper function to handle yt-dlp commands
const runYtDlp = (command) => {
  try {
    return execSync(command, {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
  } catch (error) {
    logger.error("yt-dlp command failed", {
      command,
      error: error.message,
      stderr: error.stderr?.toString(),
      stdout: error.stdout?.toString(),
    });
    throw error;
  }
};

// Download video using yt-dlp
const downloadVideo = async (
  videoUrl,
  outputPath,
  trackingFiles,
  videoInfo,
  conjunto,
  year
) => {
  logger.info(`Starting download for: ${videoUrl}`);
  logger.info(`Output path: ${outputPath}`);

  try {
    // Create clean filename
    const baseDir = path.dirname(outputPath);
    const cleanName = `${conjunto.name} ${year}`;
    const outputTemplate = path.join(baseDir, cleanName + ".%(ext)s");

    const command =
      `yt-dlp "${videoUrl}" ` +
      `--format "bestvideo[height<=1080]+bestaudio/best[height<=1080]" ` +
      `--output "${outputTemplate}" ` +
      `--write-info-json ` +
      `--download-archive "${trackingFiles.downloaded}" ` +
      "--retries 3";

    logger.info("Executing yt-dlp command...");
    execSync(command, { stdio: "inherit" });

    // Generate and save NFO file
    const nfoContent = generateNfoContent(videoInfo, conjunto, year);
    const nfoPath = path.join(baseDir, `${cleanName}.nfo`);
    await fs.writeFile(nfoPath, nfoContent);
    logger.info(`Generated NFO file at ${nfoPath}`);

    logger.info("Download completed successfully");
    return true;
  } catch (error) {
    logger.error("Download failed", { videoUrl, error: error.message });
    const failed = await fs.readJson(trackingFiles.failed);
    failed.push({ url: videoUrl, error: error.message, timestamp: new Date() });
    await fs.writeJson(trackingFiles.failed, failed);
    return false;
  }
};

// Process channel videos
const processChannel = async (
  channelUrl,
  baseDir,
  trackingFilesPath = null
) => {
  logger.info("Starting channel processing");
  logger.info(`Channel URL: ${channelUrl}`);
  logger.info(`Base directory: ${baseDir}`);

  const startTime = Date.now();
  const stats = {
    downloaded: 0,
    checkLater: 0,
    ignored: 0,
    failed: 0,
    totalSize: 0,
    categories: {},
  };

  try {
    const conjuntos = await loadConfig();
    const trackingFiles = await initTrackingFiles(trackingFilesPath || baseDir);

    logger.info("Fetching channel information...");
    const channelInfo = await youtubeDl(channelUrl, {
      dumpSingleJson: true,
      flatPlaylist: true,
      playlistReverse: true, // Oldest first
    });

    logger.info(`Found ${channelInfo.entries.length} videos in channel`);

    for (const video of channelInfo.entries) {
      const { year, conjunto } = parseVideoTitle(video.title, conjuntos);

      if (!year || !conjunto) {
        const ignored = await fs.readJson(trackingFiles.ignored);
        ignored.push({
          url: video.url,
          title: video.title,
          reason: "Missing year or conjunto information",
        });
        await fs.writeJson(trackingFiles.ignored, ignored);
        stats.ignored++;
        continue;
      }

      if (!shouldDownload(video)) {
        logger.info(
          "Video does not meet download criteria, adding to check_later list"
        );
        const checkLater = await fs.readJson(trackingFiles.checkLater);
        checkLater.push({
          url: video.url,
          title: video.title,
          reason: "Does not meet download criteria",
        });
        await fs.writeJson(trackingFiles.checkLater, checkLater);
        stats.checkLater++;
        continue;
      }

      const outputDir = path.join(baseDir, year, conjunto.category);
      await fs.ensureDir(outputDir);
      logger.info(`Created output directory: ${outputDir}`);

      const outputPath = path.join(outputDir, `${conjunto.name} ${year}`);

      const success = await downloadVideo(
        video.url,
        outputPath,
        trackingFiles,
        video,
        conjunto,
        year
      );
      if (success) {
        stats.downloaded++;
        stats.categories[conjunto.category] =
          (stats.categories[conjunto.category] || 0) + 1;
        logger.info("Download successful");
      } else {
        stats.failed++;
        logger.info("Download failed");
      }
    }

    const report = {
      ...stats,
      duration: (Date.now() - startTime) / 1000,
      timestamp: new Date().toISOString(),
    };

    const reportPath = path.join(baseDir, "download_report.json");
    await fs.writeJson(reportPath, report, { spaces: 2 });
    logger.info(`Report generated at ${reportPath}`);
    logger.info("Processing completed", report);

    return report;
  } catch (error) {
    logger.error("Channel processing failed", { error: error.message });
    throw error;
  }
};

// CLI setup
const program = new Command();

program
  .name("carnavul-downloader")
  .description("Download and organize carnival videos from YouTube")
  .version("1.0.0")
  .requiredOption("-c, --channel <url>", "YouTube channel URL")
  .requiredOption("-d, --directory <path>", "Base directory for downloads")
  .option("-t, --tracking <path>", "Override path for tracking files")
  .action(async (options) => {
    try {
      logger.info("Starting Carnavul Downloader");
      const report = await processChannel(
        options.channel,
        options.directory,
        options.tracking
      );
      console.log("\nDownload Summary:");
      console.log("----------------");
      console.log(`Videos downloaded: ${report.downloaded}`);
      console.log(`Videos for later review: ${report.checkLater}`);
      console.log(`Videos ignored: ${report.ignored}`);
      console.log(`Failed downloads: ${report.failed}`);
      console.log("\nCategory Distribution:");
      Object.entries(report.categories).forEach(([category, count]) => {
        console.log(`${category}: ${count}`);
      });
      console.log(
        `\nTotal processing time: ${report.duration.toFixed(2)} seconds`
      );
    } catch (error) {
      logger.error("Error:", error.message);
      process.exit(1);
    }
  });

program.parse();
