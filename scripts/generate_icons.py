"""Generate simple calendar PWA icons without remote assets."""
from pathlib import Path
from PIL import Image, ImageDraw

output = Path(__file__).resolve().parents[1] / 'public' / 'icons'
output.mkdir(parents=True, exist_ok=True)


def make(size: int, maskable: bool = False):
    scale = size / 512
    image = Image.new('RGB', (size, size), '#ffffff')
    draw = ImageDraw.Draw(image)
    def box(coords):
        return tuple(round(value * scale) for value in coords)
    draw.rounded_rectangle(box((54, 54, 458, 458)), radius=round(98 * scale), fill='#3169e6')
    draw.rounded_rectangle(box((129, 147, 383, 379)), radius=round(29 * scale), fill='#ffffff')
    draw.rectangle(box((129, 198, 383, 231)), fill='#dce7ff')
    for x in (190, 322):
        draw.rounded_rectangle(box((x - 14, 120, x + 14, 179)), radius=round(12 * scale), fill='#ffffff')
    for x in (180, 255, 330):
        for y in (274, 335):
            draw.rounded_rectangle(box((x - 15, y - 15, x + 15, y + 15)), radius=round(7 * scale), fill='#a9c7ff' if (x, y) != (255, 335) else '#78c99b')
    return image


make(192).save(output / 'icon-192.png')
make(512).save(output / 'icon-512.png')
make(512, True).save(output / 'maskable-512.png')
