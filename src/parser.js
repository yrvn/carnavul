import logger from "./logger.js";

/**
 * Normalize a string by removing accents, spaces, and special characters
 * @param {string} str - String to normalize
 * @returns {string} Normalized string
 */
export function normalizeString(str) {
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
  return (maxLength - distance) / maxLength;
}

/**
 * Parse video title to extract year and conjunto information
 * @param {string} title - Video title to parse
 * @param {Object} conjuntos - Configuration object containing conjunto definitions
 * @returns {Object} Parsed information including year, conjunto, and format details
 */
export function parseVideoTitle(title, conjuntos) {
  logger.info(`Parsing video title: ${title}`);

  // Skip certain types of videos
  const normalizedTitle = normalizeString(title);
  if (
    normalizedTitle.includes("pruebadeadmision") ||
    normalizedTitle.includes("desfile") ||
    normalizedTitle.includes("llamadas")
  ) {
    logger.info("Skipping video based on title keywords");
    return { year: null, conjunto: null };
  }

  // First try to parse the alternative format (4ta Etapa 2020 - Cayo La Cabra - Primera Rueda)
  const alternativeFormatRegex =
    /(\d+(?:ta|ma)) Etapa (\d{4}) - (.+?) - (Primera Rueda|Segunda Rueda|Liguilla)/i;
  const alternativeMatch = title.match(alternativeFormatRegex);

  if (alternativeMatch) {
    const [_, etapa, year, name, round] = alternativeMatch;
    logger.debug(
      `Matched alternative format - Year: ${year}, Name: ${name}, Round: ${round}`
    );

    // Find conjunto by name
    for (const [category, names] of Object.entries(conjuntos)) {
      const normalizedName = normalizeString(name);
      const conjunto = names.find((n) => {
        const similarity = calculateSimilarity(name, n);
        logger.debug(
          `Comparing (Alternative Format) "${name}" with "${n}": Similarity=${similarity.toFixed(
            2
          )}`
        );
        return similarity > 0.85;
      });

      if (conjunto) {
        logger.info(
          `Found conjunto (Alternative Format): ${conjunto} in category: ${category}`
        );
        return {
          year,
          conjunto: { name: conjunto, category },
          round,
          isAlternativeFormat: true,
        };
      }
    }
  }

  // Check for 2015 format ([1-6]A ETAPA [CONJUNTO] LIGUILLA)
  const etapa2015FormatRegex = /^(\d)A ETAPA (.+?) LIGUILLA$/i;
  const etapa2015Match = title.match(etapa2015FormatRegex);

  if (etapa2015Match) {
    const [_, etapa, name] = etapa2015Match;
    logger.info(`Matched 2015 Liguilla format. Etapa: ${etapa}, Name: ${name}`);

    // Only match if etapa is 1-6
    if (parseInt(etapa) >= 1 && parseInt(etapa) <= 6) {
      // Find conjunto by name
      for (const [category, names] of Object.entries(conjuntos)) {
        for (const n of names) {
          const similarity = calculateSimilarity(name.trim(), n);
          logger.debug(
            `Comparing (2015 Format) "${name.trim()}" with "${n}": Similarity=${similarity.toFixed(
              2
            )}`
          );

          if (similarity > 0.85) {
            logger.info(
              `Found conjunto (2015 Format): ${n} in category: ${category}`
            );
            return {
              year: "2015",
              conjunto: { name: n, category },
              round: "Liguilla",
              isAlternativeFormat: true,
            };
          }
        }
      }
      logger.warn(
        `Matched 2015 Liguilla format but couldn't find conjunto for name: ${name}`
      );
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
    for (const name of groupList) {
      const similarity = calculateSimilarity(title, name);
      if (similarity > bestMatchScore) {
        bestMatchScore = similarity;
        foundConjunto = { name, category };
      }
    }
  }

  if (bestMatchScore > 0.85) {
    logger.info(
      `Found conjunto: ${foundConjunto.name} in category: ${
        foundConjunto.category
      } with score: ${bestMatchScore.toFixed(2)}`
    );
    return { year, conjunto: foundConjunto };
  }

  logger.info("No conjunto found with sufficient similarity");
  return { year: null, conjunto: null };
}
