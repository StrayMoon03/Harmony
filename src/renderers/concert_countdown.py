"""Bounded, offline Pillow renderer. Only stdin/stdout; never opens URLs or user paths."""
import base64
import io
import json
import math
import resource
import sys
import warnings
from PIL import Image, ImageDraw, ImageFont, ImageOps

resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
Image.MAX_IMAGE_PIXELS = 16_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans'
ORANGE = '#ff862f'


def photograph(data):
    raw = base64.b64decode(data, validate=True)
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError('Photograph exceeds 4 MB')
    with Image.open(io.BytesIO(raw)) as source:
        if source.format not in ('JPEG', 'PNG'):
            raise ValueError('Use JPEG or PNG')
        if source.width * source.height > 16_000_000 or max(source.size) > 8192:
            raise ValueError('Photograph exceeds 16 megapixels or 8192 pixels per side')
        source.load()  # Decode the entire image, including truncated/invalid payload checks.
        return ImageOps.exif_transpose(source).convert('RGB')


def font(size, bold=False):
    return ImageFont.truetype(FONT + ('-Bold' if bold else '') + '.ttf', size)


def wrap(draw, text, face, width):
    lines, line = [], ''
    for word in text.split(' '):
        candidate = (line + ' ' + word).strip()
        if draw.textlength(candidate, font=face) > width and line:
            lines.append(line.rstrip())
            line = ''
        if draw.textlength(word, font=face) > width:
            for char in word:
                if draw.textlength(line + char, font=face) > width and line:
                    lines.append(line.rstrip())
                    line = ''
                line += char
        else:
            line = (line + ' ' + word).strip()
    if line:
        lines.append(line.rstrip())
    return lines or ['']


def block(draw, text, box, size, fill='#f3f2f0', bold=False, max_lines=3):
    x, y, width, height = box
    for current in range(size, 13, -1):
        face = font(current, bold)
        lines = wrap(draw, str(text), face, width)
        step = int(current * 1.3)
        if len(lines) <= max_lines and len(lines) * step <= height:
            break
    top = y + (height - len(lines) * step) / 2
    for line in lines:
        draw.text((x + width / 2, top), line, font=face, fill=fill, anchor='mt')
        top += step


def heart(draw, cx, cy, color):
    points = []
    for i in range(120):
        t = i * 2 * math.pi / 120
        points.append((cx + 1.1 * 16 * math.sin(t) ** 3,
                       cy - 1.1 * (13 * math.cos(t) - 5 * math.cos(2*t) - 2 * math.cos(3*t) - math.cos(4*t))))
    draw.polygon(points, fill=color)


def render(model, photo):
    panels = model['panels']
    if len(panels) > 12:
        raise ValueError('Too many dates')
    rows = max(1, math.ceil(len(panels) / 2))
    canvas = Image.new('RGB', (800, 458 + rows * 200), '#24252a')
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((2, 2, 797, canvas.height-3), 20, outline=ORANGE, width=2)
    block(draw, model['city'].upper() + ', ARE YOU READY?', (55, 14, 690, 68), 30, bold=True, max_lines=2)
    heart(draw, 32, 47, ORANGE)
    heart(draw, 768, 47, '#08090b')
    if photo:
        crop = ImageOps.fit(photo, (744, 200), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
        mask = Image.new('L', crop.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, 743, 199), 12, fill=255)
        canvas.paste(crop, (28, 94), mask)
    else:
        draw.rounded_rectangle((28, 94, 772, 294), 12, fill='#141519')
        block(draw, 'WORLD TOUR', (40, 143, 720, 50), 30, ORANGE, True)
        block(draw, model.get('testLabel') or 'Venue photograph coming soon', (40, 202, 720, 30), 19, '#bfc0c4')
    block(draw, model['venue'], (30, 301, 740, 60), 25, max_lines=2)
    for index, panel in enumerate(panels):
        # A final odd panel is centered, maintaining the same width as the pair above.
        single = len(panels) == 1 or (index == len(panels)-1 and len(panels) % 2)
        x = 218 if single else 28 + (index % 2) * 380
        y = 372 + (index // 2) * 200
        draw.rounded_rectangle((x, y, x+364, y+184), 14, fill='#141519')
        block(draw, 'DAY ' + str(panel['day']), (x+12, y+8, 340, 25), 17, '#c9c9ce', True)
        if panel['state'] == 'upcoming':
            block(draw, str(panel['days']), (x+12, y+29, 340, 87), 80, ORANGE, True, 1)
            block(draw, 'DAYS TO GO', (x+12, y+116, 340, 24), 18)
        else:
            block(draw, panel['label'], (x+14, y+36, 336, 101), 32, ORANGE, True)
        import datetime
        date = datetime.date.fromisoformat(panel['date'])
        block(draw, date.strftime('%B ') + str(date.day) + date.strftime(', %Y'), (x+10, y+147, 344, 29), 21)
    if not panels:
        block(draw, 'No active concert dates', (28, 372, 744, 184), 28, ORANGE)
    y = 372 + rows * 200
    block(draw, 'Different days. Same love for our eight.' if len(panels)>1 else 'Eight Kids. One STAY family.', (20, y+4, 760, 30), 22)
    block(draw, 'Youtiful STAY • World Tour Countdown', (20, y+43, 760, 25), 18, '#bfc0c4')
    output = io.BytesIO()
    canvas.save(output, format='PNG')
    return output.getvalue()


try:
    request = json.loads(sys.stdin.buffer.read(6 * 1024 * 1024))
    photo = photograph(request['photo']) if request.get('photo') else None
    if request['action'] == 'photo':
        if photo is None:
            raise ValueError('No photograph')
        if min(photo.size) < 32:
            raise ValueError('Photograph is too small')
        photo.thumbnail((2400, 1600), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        photo.save(output, format='JPEG', quality=90)
        sys.stdout.buffer.write(output.getvalue())
    else:
        sys.stdout.buffer.write(render(request['model'], photo))
except Exception as error:
    sys.stderr.write(str(error))
    sys.exit(1)
