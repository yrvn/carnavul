import logger from "./logger.js";

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
 * Parse video title to extract year and conjunto information
 * @param {string} title - Video title to parse
 * @param {Object} conjuntos - Configuration object containing conjunto definitions
 * @returns {Object} Parsed information including year, conjunto, round, and format details
 */
export function parseVideoTitle(title, conjuntos) {
  if (!title) {
    logger.warn("Attempted to parse an empty or null title.");
    return {
      year: null,
      conjunto: null,
      round: null,
      isAlternativeFormat: false,
    };
  }
  logger.info(`Parsing video title: ${title}`);

  // Skip certain types of videos
  const normalizedTitleForSkip = normalizeString(title);
  if (
    normalizedTitleForSkip.includes("pruebadeadmision") ||
    normalizedTitleForSkip.includes("desfile") ||
    normalizedTitleForSkip.includes("llamadas")
  ) {
    logger.info(
      "Skipping video based on title keywords (prueba, desfile, llamadas)"
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
  let isAlternativeFormat = false;

  // Define round keywords and their normalized forms for matching later
  const roundKeywords = {
    "Primera Rueda": "primerarueda",
    "1ra Rueda": "1rarueda", // Add variations
    "Segunda Rueda": "segundarueda",
    "2da Rueda": "2darueda",
    Liguilla: "liguilla",
  };
  const normalizedRoundKeywords = Object.values(roundKeywords);

  // --- Try specific formats first ---

  // Alternative format (e.g., "4ta Etapa 2020 - Cayo La Cabra - Primera Rueda")
  const alternativeFormatRegex =
    /(\d+(?:ta|ma|ra|da))?\s*Etapa\s*(\d{4})\s*-\s*(.+?)\s*-\s*(.+)/i; // Make etapa optional, capture everything after last '-' as potential round
  const alternativeMatch = title.match(alternativeFormatRegex);

  if (alternativeMatch) {
    const [_, etapa, matchedYear, namePart, roundPart] = alternativeMatch;
    const potentialRound = roundPart.trim();
    const normalizedPotentialRound = normalizeString(potentialRound);

    // Check if the round part actually matches known round keywords
    if (
      normalizedRoundKeywords.some((kw) =>
        normalizedPotentialRound.includes(kw)
      )
    ) {
      logger.debug(
        `Matched alternative format - Year: ${matchedYear}, Name: ${namePart.trim()}, Round: ${potentialRound}`
      );
      isAlternativeFormat = true;
      year = matchedYear;
      round = potentialRound; // Keep original casing for filename/NFO

      // Find conjunto by name part
      const matchedConjunto = findBestConjuntoMatch(
        namePart.trim(),
        conjuntos,
        0.85,
        logger,
        "(Alternative Format)"
      );
      if (matchedConjunto) {
        conjunto = matchedConjunto;
        logger.info(
          `Found conjunto (Alternative Format): ${conjunto.name} in category: ${conjunto.category}`
        );
        return { year, conjunto, round, isAlternativeFormat };
      } else {
        logger.warn(
          `Matched alternative format but couldn't find conjunto for name: ${namePart.trim()}`
        );
        // Fall through to general parsing? Or return partial? Let's return partial for now.
        return {
          year: null,
          conjunto: null,
          round: null,
          isAlternativeFormat: false,
        }; // Treat as failure if conjunto not found
      }
    } else {
      logger.debug(
        `Matched alternative format regex, but round part "${potentialRound}" doesn't match known rounds. Treating as standard title.`
      );
    }
  }

  // 2015 format (e.g., "1A ETAPA MURGA CAYO LA CABRA LIGUILLA")
  // Needs careful regex to avoid capturing too much
  const etapa2015FormatRegex = /^(\d)\s?A?\s?ETAPA\s+(.+?)\s+(LIGUILLA)$/i;
  const etapa2015Match = title.match(etapa2015FormatRegex);

  if (etapa2015Match) {
    const [_, etapa, namePart, roundPart] = etapa2015Match;
    logger.debug(
      `Matched 2015 Liguilla format. Etapa: ${etapa}, Name: ${namePart}, Round: ${roundPart}`
    );

    if (parseInt(etapa) >= 1 && parseInt(etapa) <= 6) {
      isAlternativeFormat = true;
      year = "2015";
      round = roundPart.trim(); // Usually "Liguilla"

      const matchedConjunto = findBestConjuntoMatch(
        namePart.trim(),
        conjuntos,
        0.85,
        logger,
        "(2015 Format)"
      );
      if (matchedConjunto) {
        conjunto = matchedConjunto;
        logger.info(
          `Found conjunto (2015 Format): ${conjunto.name} in category: ${conjunto.category}`
        );
        return { year, conjunto, round, isAlternativeFormat };
      } else {
        logger.warn(
          `Matched 2015 Liguilla format but couldn't find conjunto for name: ${namePart.trim()}`
        );
        return {
          year: null,
          conjunto: null,
          round: null,
          isAlternativeFormat: false,
        }; // Treat as failure
      }
    }
  }

  // --- General Parsing (if specific formats didn't fully match) ---

  // Extract year (19XX or 20XX) - Allow anywhere in the title
  const yearMatch = title.match(/\b(19[89]\d|20\d{2})\b/); // Match 1980s onwards or 20xx
  year = yearMatch ? yearMatch[0] : null;

  if (year) {
    logger.debug(`Found year (General): ${year}`);
  } else {
    logger.debug("No year found in title (General)");
  }

  // Find conjunto name using similarity against the *whole* title
  conjunto = findBestConjuntoMatch(title, conjuntos, 0.85, logger, "(General)");

  if (conjunto) {
    logger.debug(
      `Found conjunto (General): ${conjunto.name} in category: ${conjunto.category}`
    );
  } else {
    logger.debug("No conjunto found with sufficient similarity (General)");
    // If we didn't find a conjunto, the year doesn't matter much either for our purposes
    return {
      year: null,
      conjunto: null,
      round: null,
      isAlternativeFormat: false,
    };
  }

  // Extract round from the *whole* title if not found via specific formats
  if (!round) {
    const titleLower = title.toLowerCase();
    if (titleLower.includes("liguilla")) round = "Liguilla";
    else if (
      titleLower.includes("segunda rueda") ||
      titleLower.includes("2da rueda")
    )
      round = "Segunda Rueda";
    else if (
      titleLower.includes("primera rueda") ||
      titleLower.includes("1ra rueda")
    )
      round = "Primera Rueda";

    if (round) {
      logger.debug(`Found round (General): ${round}`);
    } else {
      logger.debug("No round found in title (General)");
    }
  }

  // Return the best information found
  // We need both year and conjunto to proceed generally
  if (!year || !conjunto) {
    logger.info(
      "Could not reliably identify both year and conjunto from title."
    );
    return {
      year: null,
      conjunto: null,
      round: null,
      isAlternativeFormat: false,
    };
  }

  return { year, conjunto, round, isAlternativeFormat };
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

  if (!titlePart) return null;

  for (const [category, groupList] of Object.entries(conjuntos)) {
    for (const name of groupList) {
      const similarity = calculateSimilarity(titlePart, name);
      // Optional: Add more logging for debugging similarity scores
      // logger.debug(`Comparing ${context} "${titlePart}" with "${name}": Score=${similarity.toFixed(3)}`);
      if (similarity > bestScore) {
        bestScore = similarity;
        if (similarity >= threshold) {
          // Only update bestMatch if above threshold
          bestMatch = { name, category };
        }
      }
    }
  }

  if (bestMatch) {
    logger.debug(
      `Best match ${context}: ${bestMatch.name} (Score: ${bestScore.toFixed(
        3
      )})`
    );
    return bestMatch;
  } else if (bestScore > 0.5) {
    // Log if there was a near miss
    logger.debug(
      `No conjunto match ${context} above threshold ${threshold}. Highest score was ${bestScore.toFixed(
        3
      )}.`
    );
  }

  return null;
}
