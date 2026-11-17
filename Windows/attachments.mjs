import { nativeImage } from "electron";
import { open } from "node:fs/promises";
import { basename, extname } from "node:path";

const byteLimit = 8 * 1024 * 1024;
const textLimit = 64_000;
export const attachmentLimit = 4;

async function bytesOf(path) {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("请选择单个文件。");
    if (info.size > byteLimit) throw new Error("单个附件最大为 8 MB。");
    const bytes = await file.readFile();
    if (bytes.length > byteLimit) throw new Error("单个附件最大为 8 MB。");
    return bytes;
  } finally { await file.close(); }
}

function imageFormat(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

async function documentText(bytes, type) {
  if (type === ".docx") {
    const { default: mammoth } = await import("mammoth");
    return (await mammoth.extractRawText({ buffer: bytes })).value;
  }
  if (type === ".pdf") {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    try { return (await extractText(pdf, { mergePages: true })).text; }
    finally { await pdf.destroy(); }
  }
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? "utf-16le" :
    bytes[0] === 254 && bytes[1] === 255 ? "utf-16be" : "utf-8";
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { return null; }
}

async function readAttachment(path) {
  const name = basename(path);
  const bytes = await bytesOf(path);
  const mime = imageFormat(bytes);
  if (mime) {
    const image = nativeImage.createFromBuffer(bytes);
    const { width, height } = image.getSize();
    if (image.isEmpty() && (mime === "image/png" || mime === "image/jpeg")) throw new Error("无法解码这张图片。");
    if (Math.max(width, height) > 1600) {
      const data = image.resize(width >= height ? { width: 1600 } : { height: 1600 }).toPNG();
      if (data.length > byteLimit) throw new Error("这张图片转换后超过 8 MB。");
      return { type: "image", name, data: data.toString("base64"), mimeType: "image/png" };
    }
    return { type: "image", name, data: bytes.toString("base64"), mimeType: mime };
  }

  const text = await documentText(bytes, extname(name).toLowerCase());
  if (typeof text !== "string" || text.includes("\u0000")) throw new Error("请选择图片、文本、PDF 或 DOCX 文件。");
  if (!text.trim()) throw new Error("这份文件没有可提取的文字。");
  if (text.length > textLimit) throw new Error("文件正文超过 64,000 个字符。");
  return { type: "file", name, text };
}

export async function readAttachments(paths, limit) {
  const attachments = [];
  const errors = [];
  for (const path of paths.slice(0, limit)) {
    try { attachments.push(await readAttachment(path)); }
    catch (error) { errors.push(`${basename(path)}  ${error.message}`); }
  }
  if (paths.length > limit) errors.push(`本条消息只能再添加 ${limit} 个附件。`);
  return { attachments, errors };
}
