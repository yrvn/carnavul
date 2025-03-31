import { Command } from "commander";
import { createLogger, format, transports } from "winston";
import fs from "fs-extra";
import path from "path";
import youtubeDl from "youtube-dl-exec";

// Configure logger
const logger = createLogger({
  format: format.combine(format.timestamp(), format.json()),
  transports: [
    new transports.File({ filename: "error.log", level: "error" }),
    new transports.File({ filename: "combined.log" }),
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
    }),
  ],
});

// Load configuration
const loadConfig = async () => {
  try {
    const conjuntos = await fs.readJson(
      path.join(process.cwd(), "conjuntos.json")
    );
    return conjuntos;
  } catch (error) {
    logger.error("Failed to load conjuntos.json", { error });
    throw new Error("Configuration loading failed");
  }
};

// Initialize tracking files
const initTrackingFiles = async (baseDir) => {
  const trackingDir = path.join(baseDir, ".tracking");
  await fs.ensureDir(trackingDir);

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
  }

  return files;
};

// Parse video title to extract year and conjunto name
const parseVideoTitle = (title, conjuntos) => {
  // Extract year (19XX or 20XX)
  const yearMatch = title.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? yearMatch[0] : null;

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
      break;
    }
  }

  return { year, conjunto: foundConjunto };
};

// Check if video meets download criteria
const shouldDownload = (videoInfo) => {
  const { title, duration } = videoInfo;
  const durationMinutes = parseInt(duration) / 60;

  // Check minimum duration
  if (durationMinutes < 30) return false;

  // Check title conditions
  const hasActuacionCompleta = title
    .toLowerCase()
    .includes("actuacion completa");
  const hasFragmento = title.toLowerCase().includes("fragmento");
  const hasResumen = title.toLowerCase().includes("resumen");

  // Extract year for fragmento condition
  const yearMatch = title.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? parseInt(yearMatch[0]) : null;

  if (hasResumen) return false;
  if (hasActuacionCompleta) return true;
  if (hasFragmento && year && year < 2005) return true;

  return false;
};

// Main download function
const downloadVideo = async (videoUrl, outputPath, trackingFiles) => {
  try {
    const options = {
      format: "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
      output: outputPath,
      writeInfoJson: true,
      retries: 3,
      downloadArchive: trackingFiles.downloaded,
    };

    await youtubeDl(videoUrl, options);
    return true;
  } catch (error) {
    logger.error("Download failed", { videoUrl, error });
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
    const conjuntos = await loadConfig();
    const trackingFiles = await initTrackingFiles(trackingFilesPath || baseDir);

    // Get channel videos
    const channelInfo = await youtubeDl(channelUrl, {
      dumpSingleJson: true,
      flatPlaylist: true,
      playlistReverse: true, // Oldest first
    });

    for (const video of channelInfo.entries) {
      const { year, conjunto } = parseVideoTitle(video.title, conjuntos);

      if (!year || !conjunto) {
        // Add to ignored if can't parse required info
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
      } else {
        stats.failed++;
      }
    }

    // Generate report
    const report = {
      ...stats,
      duration: (Date.now() - startTime) / 1000,
      timestamp: new Date().toISOString(),
    };

    await fs.writeJson(path.join(baseDir, "download_report.json"), report);
    logger.info("Processing completed", report);

    return report;
  } catch (error) {
    logger.error("Channel processing failed", { error });
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
      const report = await processChannel(
        options.channel,
        options.directory,
        options.tracking
      );
      console.log("Download Summary:");
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
      console.error("Error:", error.message);
      process.exit(1);
    }
  });

program.parse();
