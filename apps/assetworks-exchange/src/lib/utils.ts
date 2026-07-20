import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/** AssetWorks convention: cn = clsx + tailwind-merge (assetwork-ai-web/lib/utils). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
