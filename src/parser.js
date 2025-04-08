import logger from "./logger.js";
import { loadConfig } from "./config.js"; // Make sure this is imported if used by testParser

/**
 * Normalize a string by removing accents, spaces, and special characters
 * @param {string} str - String to normalize
 * @returns {string} Normalized string
 */
export function normalizeString(str) {
  // Ensure export keyword is present
  if (typeof str !== "string") return ""; // Handle non-string input
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/['\s]/g, "") // remove spaces and apostrophes
    .replace(/[^a-z0-9]/g, ""); // remove other special chars
}

/**
 * Calculate similarity between two strings
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Similarity score between 0 and 1
 */
export function calculateSimilarity(str1, str2) {
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
  // Avoid division by zero for empty strings
  if (maxLength === 0) return 1;
  return (maxLength - distance) / maxLength;
}

/**
 * Helper function to find the best matching conjunto name from a title string.
 * @param {string} titlePart - The string (title or part of it) to search within.
 * @param {Object} conjuntos - The configuration object.
 * @param {number} threshold - The minimum similarity score required.
 * @param {Object} logger - Logger instance.
 * @param {string} context - Logging context string (e.g., "(General)").
 * @returns {Object|null} The best matching conjunto { name, category } or null.
 */
function findBestConjuntoMatch(
  titlePart,
  conjuntos,
  threshold,
  logger,
  context = ""
) {
  let bestMatch = null;
  let bestScore = 0;
  let bestMatchCandidateName = null; // Store the name that gave the best score

  if (!titlePart) return null;

  const normalizedTitlePart = normalizeString(titlePart); // Normalize the search string once
  // logger.debug(`[findBestConjuntoMatch] ${context} Searching for conjunto matching normalized: "${normalizedTitlePart}" (Original: "${titlePart}")`);

  for (const [category, groupList] of Object.entries(conjuntos)) {
    for (const name of groupList) {
      const normalizedName = normalizeString(name);
      const similarity = calculateSimilarity(
        normalizedTitlePart,
        normalizedName
      );

      // Reduce verbosity slightly - only log scores above a lower bound, e.g., 0.5
      // if (similarity > 0.5) {
      //     logger.debug(`[findBestConjuntoMatch] ${context} Comparing "${normalizedTitlePart}" with "${normalizedName}" (${name}): Score=${similarity.toFixed(3)}`);
      // }

      if (similarity > bestScore) {
        bestScore = similarity;
        bestMatchCandidateName = name; // Remember the name for logging
        if (similarity >= threshold) {
          bestMatch = { name, category };
        }
      }
    }
  }

  if (bestMatch) {
    logger.debug(
      `[findBestConjuntoMatch] ${context} Found match: ${
        bestMatch.name
      } (Score: ${bestScore.toFixed(3)}) >= Threshold ${threshold}`
    );
    return bestMatch;
  } else {
    if (bestScore > 0.5) {
      // Log if there was a near miss
      logger.debug(
        `[findBestConjuntoMatch] ${context} No conjunto match found for "${titlePart}". Highest score was ${bestScore.toFixed(
          3
        )} for "${bestMatchCandidateName}", below threshold ${threshold}.`
      );
    } else {
      logger.debug(
        `[findBestConjuntoMatch] ${context} No conjunto match found for "${titlePart}". No potential matches found in config or score too low.`
      );
    }
    return null;
  }
}

/**
 * Parse video title to extract year, conjunto, and round information.
 * Tries specific formats first, then falls back to general matching.
 * @param {string} title - Video title to parse
 * @param {Object} conjuntos - Configuration object containing conjunto definitions
 * @returns {Object} Parsed info: { year: string|null, conjunto: { name, category }|null, round: string|null, isAlternativeFormat: boolean }
 */
export function parseVideoTitle(title, conjuntos) {
  // Exported here
  if (!title || typeof title !== "string") {
    logger.warn(
      "[parser] Attempted to parse an empty, null, or non-string title."
    );
    return {
      year: null,
      conjunto: null,
      round: null,
      isAlternativeFormat: false,
    };
  }
  // Handle specific non-content titles early
  if (
    title.startsWith("[Private video]") ||
    title.startsWith("[Deleted video]")
  ) {
    logger.info(`[parser] Skipping special title: ${title}`);
    return {
      year: null,
      conjunto: null,
      round: null,
      isAlternativeFormat: false,
    };
  }

  logger.info(`[parser] Parsing video title: ${title}`);

  // Skip certain types of videos based on keywords
  const normalizedTitleForSkip = normalizeString(title);
  if (
    normalizedTitleForSkip.includes("pruebadeadmision") ||
    normalizedTitleForSkip.includes("desfile") ||
    normalizedTitleForSkip.includes("llamadas")
  ) {
    logger.info(
      "[parser] Skipping video based on title keywords (prueba, desfile, llamadas)"
    );
    return {
      year: null,
      conjunto: null,
      round: null,
      isAlternativeFormat: false,
    };
  }

  let year = null;
  let conjunto = null;
  let round = null;
  let isAlternativeFormat = false; // Flag if a specific non-standard format matched

  // Define round keywords and their normalized forms for matching later
  const roundKeywords = {
    "Primera Rueda": "primerarueda",
    "1ra Rueda": "1rarueda", // Add variations
    "1era Rueda": "1erarueda",
    "Segunda Rueda": "segundarueda",
    "2da Rueda": "2darueda",
    Liguilla: "liguilla",
  };
  // Store original casing for display/filename
  const roundLookup = {};
  for (const [key, value] of Object.entries(roundKeywords)) {
    roundLookup[value] = key;
  }
  const normalizedRoundKeywords = Object.keys(roundLookup);

  // --- Try specific formats first ---
  // These formats attempt to parse all components. If successful, we use the result.
  // If a format matches structure but fails to find a component (like conjunto),
  // we discard the partial result from that format and allow fallback to general parsing.

  let formatMatchedSuccessfully = false; // Track if any specific format fully succeeded

  // Format: "X Etapa YYYY - Name - Round" (Year present)
  const format1Regex =
    /(\d+(?:ta|ma|ra|da))?\s*Etapa\s*(\d{4})\s*-\s*(.+?)\s*-\s*(.+)/i;
  const format1Match = title.match(format1Regex);
  if (format1Match) {
    const [_, etapa, matchedYear, namePartRaw, roundPart] = format1Match;
    const namePart = namePartRaw.trim();
    const potentialRound = roundPart.trim();
    const normalizedPotentialRound = normalizeString(potentialRound);
    const matchedRoundKeyword = normalizedRoundKeywords.find((kw) =>
      normalizedPotentialRound.includes(kw)
    );

    if (matchedRoundKeyword) {
      logger.debug(
        `[parser] Matched Format 1 Structure (Year Present) - Extracted Name: "${namePart}", Round: "${potentialRound}"`
      );
      const currentRound = roundLookup[matchedRoundKeyword];
      const matchedConjunto = findBestConjuntoMatch(
        namePart,
        conjuntos,
        0.85,
        logger,
        "(Format 1)"
      );

      if (matchedConjunto) {
        logger.debug(
          `[parser] Format 1: Successfully parsed all parts. Using this result.`
        );
        formatMatchedSuccessfully = true; // Mark success
        year = matchedYear;
        conjunto = matchedConjunto;
        round = currentRound;
        isAlternativeFormat = true;
        // Don't return early, let general parsing check if it finds *more* info? No, specific is better.
        // return { year, conjunto, round, isAlternativeFormat };
      } else {
        logger.debug(
          `[parser] Format 1: Matched structure but failed to find conjunto for "${namePart}". Discarding partial result, allowing fallback.`
        );
      }
    } else {
      logger.debug(
        `[parser] Format 1: Matched structure but round part "${potentialRound}" invalid. Allowing fallback.`
      );
    }
  }

  // Format: "X Etapa - Name - Round" (Year MISSING)
  // Only try if Format 1 didn't successfully find everything
  if (!formatMatchedSuccessfully) {
    const format2Regex = /(\d+(?:ta|ma|ra|da))\s*Etapa\s*-\s*(.+?)\s*-\s*(.+)/i;
    const format2Match = title.match(format2Regex);
    if (format2Match) {
      const [_, etapa, namePartRaw, roundPart] = format2Match;
      const namePart = namePartRaw.trim();
      const potentialRound = roundPart.trim();
      const normalizedPotentialRound = normalizeString(potentialRound);
      const matchedRoundKeyword = normalizedRoundKeywords.find((kw) =>
        normalizedPotentialRound.includes(kw)
      );

      if (matchedRoundKeyword) {
        logger.debug(
          `[parser] Matched Format 2 Structure (Year Missing) - Extracted Name: "${namePart}", Round: "${potentialRound}"`
        );
        const currentRound = roundLookup[matchedRoundKeyword];
        const matchedConjunto = findBestConjuntoMatch(
          namePart,
          conjuntos,
          0.85,
          logger,
          "(Format 2)"
        );

        if (matchedConjunto) {
          logger.debug(
            `[parser] Format 2: Successfully parsed conjunto and round. Year is null. Using this result.`
          );
          formatMatchedSuccessfully = true; // Mark success
          year = null; // Explicitly null
          conjunto = matchedConjunto;
          round = currentRound;
          isAlternativeFormat = true;
          // return { year, conjunto, round, isAlternativeFormat };
        } else {
          logger.debug(
            `[parser] Format 2: Matched structure but failed to find conjunto for "${namePart}". Discarding partial result, allowing fallback.`
          );
        }
      } else {
        logger.debug(
          `[parser] Format 2: Matched structure but round part "${potentialRound}" invalid. Allowing fallback.`
        );
      }
    }
  }

  // Format: 2015 Liguilla ("XA ETAPA NAME LIGUILLA")
  // Only try if previous formats didn't successfully find everything
  if (!formatMatchedSuccessfully) {
    const etapa2015FormatRegex = /^(\d)\s?A?\s?ETAPA\s+(.+?)\s+(LIGUILLA)$/i;
    const etapa2015Match = title.match(etapa2015FormatRegex);
    if (etapa2015Match) {
      const [_, etapa, namePartRaw, roundPart] = etapa2015Match;
      const namePart = namePartRaw.trim();
      logger.debug(
        `[parser] Matched 2015 Liguilla Structure - Extracted Name: "${namePart}"`
      );

      if (parseInt(etapa) >= 1 && parseInt(etapa) <= 6) {
        const currentRound = "Liguilla";
        const matchedConjunto = findBestConjuntoMatch(
          namePart,
          conjuntos,
          0.85,
          logger,
          "(2015 Format)"
        );
        if (matchedConjunto) {
          logger.debug(
            `[parser] 2015 Format: Successfully parsed all parts. Using this result.`
          );
          formatMatchedSuccessfully = true; // Mark success
          year = "2015";
          conjunto = matchedConjunto;
          round = currentRound;
          isAlternativeFormat = true;
          // return { year, conjunto, round, isAlternativeFormat };
        } else {
          logger.debug(
            `[parser] 2015 Format: Matched structure but failed to find conjunto for "${namePart}". Discarding partial result, allowing fallback.`
          );
        }
      } else {
        logger.debug(
          `[parser] 2015 Format: Matched structure but etapa number invalid. Allowing fallback.`
        );
      }
    }
  }

  // --- General Fallback Parsing ---
  // This section runs if NO specific format above successfully found all components.
  // It attempts to fill in missing pieces (year, conjunto, round) if they weren't found.
  if (!formatMatchedSuccessfully) {
    logger.debug(
      "[parser] No specific format fully succeeded, attempting General Fallback Parsing..."
    );

    // Try finding conjunto generally using the whole title *if not already found*
    if (!conjunto) {
      conjunto = findBestConjuntoMatch(
        title,
        conjuntos,
        0.85,
        logger,
        "(General Fallback)"
      );
      if (!conjunto) {
        logger.info("[parser] Fallback failed to find Conjunto.");
        // If no conjunto found even in fallback, return failure
        return {
          year: null,
          conjunto: null,
          round: null,
          isAlternativeFormat: false,
        };
      }
    }

    // Try finding year generally *if not already found*
    if (!year) {
      const yearMatch = title.match(/\b(19[89]\d|20\d{2})\b/);
      year = yearMatch ? yearMatch[0] : null;
      if (!year) {
        logger.info("[parser] Fallback failed to find Year.");
      }
    }

    // Try finding round generally *if not already found*
    if (!round) {
      const titleLowerNorm = normalizeString(title);
      const matchedRoundKeyword = normalizedRoundKeywords.find((kw) =>
        titleLowerNorm.includes(kw)
      );
      round = matchedRoundKeyword ? roundLookup[matchedRoundKeyword] : null;
      if (!round) {
        logger.debug("[parser] Fallback did not find Round.");
      }
    }
    isAlternativeFormat = false; // General parsing is not an alternative format
  } // End of general fallback parsing block

  // Final Result Consolidation / Logging
  if (!conjunto) {
    // This case should ideally be handled by the return inside the fallback block
    logger.error(
      "[parser] Final Result: Reached end without identifying Conjunto. This shouldn't happen."
    );
    return {
      year: null,
      conjunto: null,
      round: null,
      isAlternativeFormat: false,
    };
  }
  if (!year) {
    logger.info(
      `[parser] Final Result: Identified conjunto (${conjunto?.name}), Round (${round}) but not Year.`
    );
  } else {
    logger.info(
      `[parser] Final Result: Year=${year}, Conjunto=${conjunto?.name}, Round=${round}`
    );
  }

  // Return the combined result
  return { year, conjunto, round, isAlternativeFormat };
}

// Make sure exports are correct
// Remove parseVideoTitle from here as it's exported with 'export function'
export { normalizeString, calculateSimilarity };
