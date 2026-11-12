import { join } from "node:path";
import { type DirectorMark, logoSymbol, markSymbolFromSvg, monogramSymbol } from "@studix/renderers";
import type { VideoIR } from "@studix/video-ir";
import type { StageContext } from "@studix/workflow";

/**
 * The brand mark a film-mode composition shows as `#sx-mark`: the brand kit's logo when it has one, else the
 * small SVG mark the director drew (sanitized to plain shapes), else a deterministic monogram of the brand's
 * name. A generated mark is recorded (`metadata.generatedMark`) and warned about, so the user knows the film
 * shows a mark Studix made, not theirs.
 */

const LOGO_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export interface FilmMark {
  mark: DirectorMark;
  /** How the mark was made when the brand kit has no usable logo. */
  generated?: "director" | "monogram";
  warning?: string;
}

/** Name the monogram is drawn from: the brand's, else the graphic's title. */
export const markNameOf = (ir: VideoIR) => ir.brand?.name ?? ir.title ?? "";

export async function resolveFilmMark(
  s: StageContext,
  ir: VideoIR,
  directorSvg: string | undefined,
  workDir: string,
): Promise<FilmMark> {
  const logo = ir.brand?.logoAssetId
    ? ir.assets.find((a) => a.id === ir.brand?.logoAssetId && a.kind === "image")
    : undefined;
  const ext = logo?.mime ? LOGO_EXTENSIONS[logo.mime] : undefined;
  let logoWarning: string | undefined;
  if (logo?.storageKey && ext && s.services.storage) {
    try {
      const source = join(workDir, `brand-logo.${ext}`);
      await s.services.storage.download(s.ctx, logo.storageKey, source);
      const dest = `assets/brand/logo.${ext}`;
      return { mark: { symbol: logoSymbol(dest), copy: { dest, source } } };
    } catch {
      logoWarning = "the brand kit's logo could not be read";
    }
  }
  const drawn = directorSvg ? markSymbolFromSvg(directorSvg) : undefined;
  const generated = drawn ? "director" : "monogram";
  const why = logoWarning ?? "the brand kit has no logo";
  return {
    mark: { symbol: drawn ?? monogramSymbol(markNameOf(ir)) },
    generated,
    warning:
      `The film shows a ${generated === "director" ? "mark the director drew" : "monogram"} because ${why}; ` +
      "add a logo to the brand kit to show yours",
  };
}
