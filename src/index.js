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

  // Initialize files if they don't exist
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

  // Find conjunto name
  let foundConjunto = null;
  for (const [category, groupList] of Object.entries(conjuntos)) {
    const conjunto = groupList.find((name) =>
      title.toLowerCase().includes(name.toLowerCase())
    );
    if (conjunto) {
      foundConjunto = {
        name: conjunto,
        category,
      };
      logger.info(`Found conjunto: ${conjunto} in category: ${category}`);
      break;
    }
  }

  if (!foundConjunto) {
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

  // Check minimum duration
  if (durationMinutes < 30) {
    logger.info("Video too short, skipping");
    return false;
  }

  // Check title conditions
  const hasActuacionCompleta = title
    .toLowerCase()
    .includes("actuacion completa");
  const hasFragmento = title.toLowerCase().includes("fragmento");
  const hasResumen = title.toLowerCase().includes("resumen");

  logger.info(
    `Title conditions: actuacion completa: ${hasActuacionCompleta}, fragmento: ${hasFragmento}, resumen: ${hasResumen}`
  );

  // Extract year for fragmento condition
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

// Download video using yt-dlp
const downloadVideo = async (videoUrl, outputPath, trackingFiles) => {
  logger.info(`Starting download for: ${videoUrl}`);
  logger.info(`Output path: ${outputPath}`);

  try {
    const command =
      `yt-dlp "${videoUrl}" ` +
      `--format "bestvideo[height<=1080]+bestaudio/best[height<=1080]" ` +
      `--output "${outputPath}" ` +
      `--write-info-json ` +
      `--download-archive "${trackingFiles.downloaded}" ` +
      "--retries 3";

    logger.info("Executing yt-dlp command...");
    execSync(command, { stdio: "inherit" });
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
    // Load configuration and initialize tracking
    logger.info("Loading configuration and initializing tracking files...");
    const conjuntos = await loadConfig();
    const trackingFiles = await initTrackingFiles(trackingFilesPath || baseDir);

    // Get channel videos
    logger.info("Fetching channel information...");
    const command = `yt-dlp "${channelUrl}" --dump-json --flat-playlist --playlist-reverse`;
    const result = execSync(command).toString();
    const videos = result
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    logger.info(`Found ${videos.length} videos in channel`);

    for (const [index, video] of videos.entries()) {
      logger.info(
        `Processing video ${index + 1}/${videos.length}: ${video.title}`
      );

      const { year, conjunto } = parseVideoTitle(video.title, conjuntos);

      if (!year || !conjunto) {
        logger.info(
          "Missing year or conjunto information, adding to ignored list"
        );
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

      // Create output directory structure
      const outputDir = path.join(baseDir, year, conjunto.category);
      await fs.ensureDir(outputDir);
      logger.info(`Created output directory: ${outputDir}`);

      const outputPath = path.join(
        outputDir,
        `${conjunto.name} - ${year}%(title)s.%(ext)s`
      );

      // Download video
      const success = await downloadVideo(video.url, outputPath, trackingFiles);
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

    // Generate report
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
