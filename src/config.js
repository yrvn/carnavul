import fs from "fs-extra";
import path from "path";
import logger from "./logger.js";

/**
 * Loads and validates the configuration file
 * @param {string} configPath - Path to the configuration file
 * @returns {Promise<Object>} The loaded configuration object
 * @throws {Error} If the file cannot be read or validation fails
 */
export async function loadConfig(configPath = "conjuntos.json") {
  try {
    logger.info(`Loading configuration from ${configPath}...`);
    const config = await fs.readJson(path.join(process.cwd(), configPath));

    // Basic validation
    if (!config || typeof config !== "object") {
      throw new Error("Configuration must be a valid JSON object");
    }

    // Check if it has at least one category with an array of conjuntos
    const categories = Object.entries(config);
    if (categories.length === 0) {
      throw new Error("Configuration must contain at least one category");
    }

    for (const [category, conjuntos] of categories) {
      if (!Array.isArray(conjuntos)) {
        throw new Error(
          `Category '${category}' must contain an array of conjuntos`
        );
      }
      if (conjuntos.length === 0) {
        logger.warn(`Category '${category}' has no conjuntos defined`);
      }
    }

    logger.info(
      `Configuration loaded successfully. Found ${categories.length} categories`
    );
    return config;
  } catch (error) {
    logger.error("Failed to load configuration", {
      path: configPath,
      error: error.message,
    });
    throw new Error(`Configuration loading failed: ${error.message}`);
  }
}
