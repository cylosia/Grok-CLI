import { GrokAgent } from "./grok-agent.js";
import { Repomap2 } from "./repomap.js";
import { logger } from "../utils/logger.js";

export interface VisionRequest {
  imageBase64: string;
  prompt: string;
}

const MAX_IMAGE_BASE64_BYTES = 10_000_000; // 10MB

export class VisionEngine {
  private agent: GrokAgent;
  private repomap: Repomap2;

  constructor(agent: GrokAgent) {
    this.agent = agent;
    this.repomap = new Repomap2();
  }

  async analyzeScreenshot(imageBase64: string, prompt: string): Promise<import("./grok-agent.js").ChatEntry[]> {
    if (imageBase64.length > MAX_IMAGE_BASE64_BYTES) {
      throw new Error(`Image data exceeds maximum size of ${MAX_IMAGE_BASE64_BYTES} bytes`);
    }
    if (!/^[A-Za-z0-9+/\r\n]+=*$/.test(imageBase64)) {
      throw new Error("Image data is not valid base64");
    }
    logger.info("vision-analyze-screenshot", { component: "vision-engine", promptLength: prompt.length, imageBytes: imageBase64.length });
    const context = await this.repomap.getRelevantFiles(prompt, 5);
    const result = await this.agent.processUserMessage(`Analyze this image: ${prompt}\nRelevant files: ${context.join(", ")}\n[Image data: ${imageBase64.length} bytes attached]`);
    return result;
  }
}
