import { createLogger, format, transports } from "winston";

// Configure logger with console and file transports
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

export default logger;
