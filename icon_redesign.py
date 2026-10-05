from pathlib import Path
import io
import subprocess
from PIL import Image, ImageDraw

ROOT = Path(__file__).parent
SCALE = 0.76
APPS = {
    "Clip": ROOT / "Clip/src-tauri/icons",
    "Echo": ROOT / "Echo/src-tauri/icons",
    "Folio": ROOT / "Folio/app/folio/src-tauri/icons",
    "Forge": ROOT / "Forge/src-tauri/icons",
    "Lens": ROOT / "Lens/src-tauri/icons",
    "Mark": ROOT / "Mark/src-tauri/icons",
    "Reel": ROOT / "Reel/src-tauri/icons",
    "Seal": ROOT / "Seal/src-tauri/icons",
    "Shift": ROOT / "Shift/src-tauri/icons",
    "Shred": ROOT / "Shred/src-tauri/icons",
    "Vault": ROOT / "Vault/src-tauri/icons",
    "Vector": ROOT / "Vector/src-tauri/icons",
    "Veil": ROOT / "Veil/src-tauri/icons",
}
PNG_SIZES = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}


def foreground_alpha(image):
    luminance = image.convert("RGBA").convert("L")
    return luminance.point(lambda value: 0 if value <= 40 else min(255, round((value - 40) * 255 / 205)))


def original_icon(icon_dir):
    relative = (icon_dir / "icon.png").relative_to(ROOT).as_posix()
    original = subprocess.check_output(["git", "show", f"HEAD:{relative}"], cwd=ROOT)
    return Image.open(io.BytesIO(original)).convert("RGBA")


def redesign(image):
    image = image.convert("RGBA")
    alpha = foreground_alpha(image)
    crop_mask = alpha.point(lambda value: 255 if value >= 170 else 0)
    clear_mask = alpha.point(lambda value: 255 if value > 0 else 0)
    bbox = crop_mask.getbbox()
    if not bbox:
        return image

    foreground = image.copy()
    foreground.putalpha(alpha)
    foreground = foreground.crop(bbox)
    background = image.copy()
    background.paste((26, 26, 24, 255), (0, 0, image.width, image.height), clear_mask)
    target_size = max(1, round(max(foreground.size) * SCALE))
    ratio = target_size / max(foreground.size)
    resized = foreground.resize((round(foreground.width * ratio), round(foreground.height * ratio)), Image.Resampling.LANCZOS)

    result = background
    x = (image.width - resized.width) // 2
    y = (image.height - resized.height) // 2
    result.alpha_composite(resized, (x, y))
    return result


preview_dir = ROOT / "release-assets/desktop-icons-redesigned"
preview_dir.mkdir(parents=True, exist_ok=True)
preview_images = []

for app, icon_dir in APPS.items():
    source = original_icon(icon_dir)
    redesigned = redesign(source)
    for filename, size in PNG_SIZES.items():
        redesigned.resize((size, size), Image.Resampling.LANCZOS).save(icon_dir / filename, "PNG", optimize=True)
    redesigned.save(icon_dir / "icon.ico", "ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    preview_path = preview_dir / f"{app}.png"
    redesigned.save(preview_path, "PNG", optimize=True)
    preview_images.append((app, redesigned))

cell = 640
label_height = 56
columns = 4
rows = (len(preview_images) + columns - 1) // columns
sheet = Image.new("RGBA", (columns * cell, rows * (cell + label_height)), (32, 32, 30, 255))
draw = ImageDraw.Draw(sheet)
for index, (app, image) in enumerate(preview_images):
    x = (index % columns) * cell
    y = (index // columns) * (cell + label_height)
    enlarged = image.resize((cell, cell), Image.Resampling.NEAREST)
    sheet.alpha_composite(enlarged, (x, y))
    draw.text((x + 24, y + cell + 14), app, fill=(245, 245, 244, 255))
sheet.save(preview_dir / "all-desktop-icons.png", "PNG", optimize=True)
print(f"Redesigned {len(APPS)} icon sets with a {SCALE:.0%} foreground scale.")
print(f"Preview folder: {preview_dir}")
