import { GrokAgent } from "./grok-agent.js";
import { Repomap2 } from "./repomap.js";
import { logger } from "../utils/logger.js";

export interface VisionRequest {
  imageBase64: string;
  prompt: string;
}

export class VisionEngine {
  private agent: GrokAgent;
  private repomap: Repomap2;

  constructor(agent: GrokAgent) {
    this.agent = agent;
    this.repomap = new Repomap2();
  }

  async analyzeScreenshot(imageBase64: string, prompt: string) {
    logger.info("vision-analyze-screenshot", { component: "vision-engine", promptLength: prompt.length });
    const context = await this.repomap.getRelevantFiles(prompt, 5);
    const result = await this.agent.processUserMessage(`Analyze this image: ${prompt}\nRelevant files: ${context.join(", ")}\nImage data: ${imageBase64.slice(0, 100)}...`);
    return result;
  }
}
