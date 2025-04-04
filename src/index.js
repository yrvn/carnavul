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
  const title =
    videoInfo.isAlternativeFormat && videoInfo.round
      ? `${conjunto.name} ${year} - ${videoInfo.round}`
      : `${conjunto.name} ${year}`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
    <title>${title}</title>
    <originaltitle>${videoInfo.title}</originaltitle>
    <sorttitle>${conjunto.name} ${year}</sorttitle>
    <year>${year}</year>
    <genre>Carnival</genre>
    <genre>${conjunto.category}</genre>
    ${videoInfo.round ? `<genre>${videoInfo.round}</genre>` : ""}
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
    incomplete: path.join(trackingDir, "incomplete.json"),
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

  // Skip certain types of videos
  const normalizedTitle = normalizeString(title);
  if (
    normalizedTitle.includes("pruebadeadmision") ||
    normalizedTitle.includes("desfile") ||
    normalizedTitle.includes("llamadas")
  ) {
    return { year: null, conjunto: null };
  }

  // First try to parse the alternative format (4ta Etapa 2020 - Cayo La Cabra - Primera Rueda)
  const alternativeFormatRegex =
    /(\d+(?:ta|ma)) Etapa (\d{4}) - (.+?) - (Primera Rueda|Segunda Rueda|Liguilla)/i;
  const alternativeMatch = title.match(alternativeFormatRegex);

  if (alternativeMatch) {
    const [_, etapa, year, name, round] = alternativeMatch;
    // Find conjunto by name
    for (const [category, names] of Object.entries(conjuntos)) {
      const normalizedName = normalizeString(name);
      const conjunto = names.find((n) => {
        const similarity = calculateSimilarity(name, n);
        return similarity > 0.85;
      });
      if (conjunto) {
        return {
          year,
          conjunto: { name: conjunto, category },
          round, // Store the round information
          isAlternativeFormat: true,
        };
      }
    }
  }

  // Check for 2015 format ([1-6]A ETAPA [CONJUNTO] LIGUILLA)
  const etapaFormatRegex = /^(\d)A ETAPA (.+?) LIGUILLA$/i;
  const etapaMatch = title.match(etapaFormatRegex);

  if (etapaMatch) {
    const [_, etapa, name] = etapaMatch;
    // Only match if etapa is 1-6
    if (parseInt(etapa) >= 1 && parseInt(etapa) <= 6) {
      // Find conjunto by name
      for (const [category, names] of Object.entries(conjuntos)) {
        const conjunto = names.find((n) => {
          const similarity = calculateSimilarity(name, n);
          return similarity > 0.85;
        });
        if (conjunto) {
          return {
            year: "2015",
            conjunto: { name: conjunto, category },
            round: "Liguilla",
            isAlternativeFormat: true,
          };
        }
      }
    }
  }

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
  const normalizedTitle = normalizeString(title);

  // Competition round format should always download
  const roundMatch =
    /(\d+(?:ta|ma)) Etapa .+ (Primera Rueda|Segunda Rueda|Liguilla)/i.test(
      title
    );
  if (roundMatch) {
    logger.info("Video is a competition round, will download");
    return true;
  }

  if (durationMinutes < 30) {
    logger.info("Video too short, skipping");
    return false;
  }

  const hasActuacionCompleta = normalizedTitle.includes("actuacioncompleta");
  const hasFragmento = normalizedTitle.includes("fragmento");
  const hasResumen = normalizedTitle.includes("resumen");

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
    const baseDir = path.dirname(outputPath);

    // Generate filename based on format
    let cleanName;
    if (videoInfo.isAlternativeFormat && videoInfo.round) {
      cleanName = `${conjunto.name} ${year} - ${videoInfo.round}`;
    } else {
      cleanName = `${conjunto.name} ${year}`;
    }

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
          reason: `Could not identify ${
            !year ? "year" : "conjunto name"
          } in title: "${video.title}"`,
          metadata: {
            yearFound: year || null,
            conjuntoFound: conjunto?.name || null,
            normalizedTitle: normalizeString(video.title),
          },
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
          reason: `Video duration: ${video.duration}s. Must be >30min or contain 'actuacion completa' or ('fragmento' and year < 2005). Title cannot contain 'RESUMEN'`,
          metadata: {
            duration: video.duration,
            hasActuacionCompleta: video.title
              .toLowerCase()
              .includes("actuacion completa"),
            hasFragmento: video.title.toLowerCase().includes("fragmento"),
            hasResumen: video.title.toUpperCase().includes("RESUMEN"),
            year: year,
          },
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

// Process videos from check_later.json
const processCheckLater = async (baseDir, trackingFilesPath = null) => {
  logger.info("Starting check_later.json processing");
  logger.info(`Base directory: ${baseDir}`);

  const startTime = Date.now();
  const stats = {
    downloaded: 0,
    ignored: 0,
    incomplete: 0,
    failed: 0,
    totalSize: 0,
    categories: {},
  };

  try {
    const conjuntos = await loadConfig();
    const trackingFiles = await initTrackingFiles(trackingFilesPath || baseDir);

    // Read check_later.json
    const checkLaterPath = path.join(baseDir, ".tracking", "check_later.json");
    const checkLater = await fs.readJson(checkLaterPath);
    const newCheckLater = [];

    logger.info(`Found ${checkLater.length} videos in check_later.json`);

    for (const video of checkLater) {
      if (!video.download) {
        // Move to incomplete.json if no download property
        const incomplete = await fs.readJson(trackingFiles.incomplete);
        incomplete.push({
          ...video,
          reason: "No download property set in check_later.json",
        });
        await fs.writeJson(trackingFiles.incomplete, incomplete);
        stats.incomplete++;
        continue;
      }

      // Process video for download since it has download: true
      const { year, conjunto } = parseVideoTitle(video.title, conjuntos);

      if (!year || !conjunto) {
        // Move to ignored if we can't parse the title
        const ignored = await fs.readJson(trackingFiles.ignored);
        ignored.push({
          ...video,
          reason: `Could not identify ${
            !year ? "year" : "conjunto name"
          } in title`,
        });
        await fs.writeJson(trackingFiles.ignored, ignored);
        stats.ignored++;
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

    // Save the updated check_later.json without the processed videos
    await fs.writeJson(checkLaterPath, newCheckLater, { spaces: 2 });

    const report = {
      ...stats,
      duration: (Date.now() - startTime) / 1000,
      timestamp: new Date().toISOString(),
    };

    const reportPath = path.join(baseDir, "check_later_report.json");
    await fs.writeJson(reportPath, report, { spaces: 2 });
    logger.info(`Report generated at ${reportPath}`);
    logger.info("Processing completed", report);

    return report;
  } catch (error) {
    logger.error("Check later processing failed", { error: error.message });
    throw error;
  }
};

// Process a single video URL
const processSingleVideo = async (
  videoUrl,
  baseDir,
  trackingFilesPath = null
) => {
  logger.info("Starting single video processing");
  logger.info(`Video URL: ${videoUrl}`);
  logger.info(`Base directory: ${baseDir}`);

  const startTime = Date.now();
  const stats = {
    downloaded: 0,
    ignored: 0,
    failed: 0,
    categories: {},
  };

  try {
    const conjuntos = await loadConfig();
    const trackingFiles = await initTrackingFiles(trackingFilesPath || baseDir);

    logger.info("Fetching video information...");
    const videoInfo = await youtubeDl(videoUrl, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
    });

    const { year, conjunto } = parseVideoTitle(videoInfo.title, conjuntos);

    if (!year || !conjunto) {
      const ignored = await fs.readJson(trackingFiles.ignored);
      ignored.push({
        url: videoUrl,
        title: videoInfo.title,
        reason: `Could not identify ${
          !year ? "year" : "conjunto name"
        } in title: "${videoInfo.title}"`,
        metadata: {
          yearFound: year || null,
          conjuntoFound: conjunto?.name || null,
          normalizedTitle: normalizeString(videoInfo.title),
        },
      });
      await fs.writeJson(trackingFiles.ignored, ignored);
      stats.ignored++;
      logger.info("Video ignored due to unidentifiable year or conjunto");

      return {
        ...stats,
        duration: (Date.now() - startTime) / 1000,
        timestamp: new Date().toISOString(),
        status: "ignored",
        reason: `Could not identify ${
          !year ? "year" : "conjunto name"
        } in title`,
      };
    }

    if (!shouldDownload(videoInfo)) {
      const checkLater = await fs.readJson(trackingFiles.checkLater);
      checkLater.push({
        url: videoUrl,
        title: videoInfo.title,
        reason: `Video duration: ${videoInfo.duration}s. Must be >30min or contain 'actuacion completa' or ('fragmento' and year < 2005). Title cannot contain 'RESUMEN'`,
        metadata: {
          duration: videoInfo.duration,
          hasActuacionCompleta: videoInfo.title
            .toLowerCase()
            .includes("actuacion completa"),
          hasFragmento: videoInfo.title.toLowerCase().includes("fragmento"),
          hasResumen: videoInfo.title.toUpperCase().includes("RESUMEN"),
          year: year,
        },
      });
      await fs.writeJson(trackingFiles.checkLater, checkLater);
      logger.info("Video added to check_later list");

      return {
        ...stats,
        duration: (Date.now() - startTime) / 1000,
        timestamp: new Date().toISOString(),
        status: "check_later",
        reason: "Does not meet download criteria",
      };
    }

    const outputDir = path.join(baseDir, year, conjunto.category);
    await fs.ensureDir(outputDir);
    logger.info(`Created output directory: ${outputDir}`);

    const outputPath = path.join(outputDir, `${conjunto.name} ${year}`);

    const success = await downloadVideo(
      videoUrl,
      outputPath,
      trackingFiles,
      videoInfo,
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

    const report = {
      ...stats,
      duration: (Date.now() - startTime) / 1000,
      timestamp: new Date().toISOString(),
      status: success ? "success" : "failed",
    };

    const reportPath = path.join(baseDir, "single_video_report.json");
    await fs.writeJson(reportPath, report, { spaces: 2 });
    logger.info(`Report generated at ${reportPath}`);
    logger.info("Processing completed", report);

    return report;
  } catch (error) {
    logger.error("Single video processing failed", { error: error.message });
    return {
      ...stats,
      duration: (Date.now() - startTime) / 1000,
      timestamp: new Date().toISOString(),
      status: "failed",
      error: error.message,
    };
  }
};

// CLI setup
const program = new Command();

program
  .name("carnavul-downloader")
  .description("Download and organize carnival videos from YouTube")
  .version("1.0.0")
  .option("-c, --channel <url>", "YouTube channel URL")
  .option("-v, --video <url>", "Single YouTube video URL")
  .requiredOption("-d, --directory <path>", "Base directory for downloads")
  .option("-t, --tracking <path>", "Override path for tracking files")
  .action(async (options) => {
    try {
      logger.info("Starting Carnavul Downloader");

      if (options.video) {
        // Process single video
        const report = await processSingleVideo(
          options.video,
          options.directory,
          options.tracking
        );
        console.log("\nSingle Video Download Summary:");
        console.log("----------------------------");
        console.log(`Status: ${report.status}`);
        if (report.error) {
          console.log(`Error: ${report.error}`);
        }
        if (report.reason) {
          console.log(`Reason: ${report.reason}`);
        }
        if (Object.keys(report.categories).length > 0) {
          console.log("\nCategory:");
          Object.entries(report.categories).forEach(([category, count]) => {
            console.log(`${category}: ${count}`);
          });
        }
        console.log(
          `\nTotal processing time: ${report.duration.toFixed(2)} seconds`
        );
      } else if (options.channel) {
        // Process channel as before
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
      } else {
        // Process check_later.json
        logger.info("No channel URL provided, processing check_later.json");
        const report = await processCheckLater(
          options.directory,
          options.tracking
        );
        console.log("\nCheck Later Processing Summary:");
        console.log("-----------------------------");
        console.log(`Videos downloaded: ${report.downloaded}`);
        console.log(`Videos moved to incomplete: ${report.incomplete}`);
        console.log(`Videos ignored (invalid title): ${report.ignored}`);
        console.log(`Failed downloads: ${report.failed}`);
        console.log("\nCategory Distribution:");
        Object.entries(report.categories).forEach(([category, count]) => {
          console.log(`${category}: ${count}`);
        });
        console.log(
          `\nTotal processing time: ${report.duration.toFixed(2)} seconds`
        );
      }
    } catch (error) {
      logger.error("Error:", error.message);
      process.exit(1);
    }
  });

program.parse();
