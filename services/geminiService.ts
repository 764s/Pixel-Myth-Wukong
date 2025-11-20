import { GoogleGenAI, Type } from "@google/genai";
import { LevelData } from "../types";

const apiKey = process.env.API_KEY || '';
const ai = new GoogleGenAI({ apiKey });

export const generateLevelLore = async (): Promise<LevelData> => {
  // Fallback if no key is present (for dev resilience)
  if (!apiKey) {
    return {
      chapterTitle: "第一回: 黑风山",
      introText: "三界四洲，万物有灵。昔日大圣以此为家，如今只余焦土与哀鸣。风起之处，必有妖邪。",
      bossName: "黑风大王",
      bossDescription: "占据黑风洞的黑熊精，贪婪成性，力大无穷，曾觊觎锦襕袈裟。"
    };
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Generate a dark, mythic level introduction for a game inspired by 'Black Myth: Wukong'. Output in Simplified Chinese. Include a chapter title (ancient Chinese style), a poetic intro text (under 40 words), a boss name, and a short boss description.",
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            chapterTitle: { type: Type.STRING },
            introText: { type: Type.STRING },
            bossName: { type: Type.STRING },
            bossDescription: { type: Type.STRING },
          },
          required: ["chapterTitle", "introText", "bossName", "bossDescription"]
        }
      }
    });

    const text = response.text;
    if (!text) throw new Error("No response from Gemini");
    return JSON.parse(text) as LevelData;

  } catch (error) {
    console.error("Gemini API Error:", error);
    // Fallback on error
    return {
      chapterTitle: "第一回: 花果山",
      introText: "迷雾遮蔽了归途，同族的呼唤在山谷回荡。你必须重拾天命，哪怕前路是万丈深渊。",
      bossName: "石先锋",
      bossDescription: "上古灵石化作的巨怪，坚不可摧，守护着古老的秘密。"
    };
  }
};