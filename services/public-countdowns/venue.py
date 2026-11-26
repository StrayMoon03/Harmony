"""Static Open Graph photograph; no dates/countdown values, URLs, or file paths."""
import io
import resource
import sys
from PIL import Image, ImageOps
resource.setrlimit(resource.RLIMIT_AS, (256*1024*1024, 256*1024*1024))
resource.setrlimit(resource.RLIMIT_CPU, (5,5))
raw=sys.stdin.buffer.read(4*1024*1024+1)
if len(raw)>4*1024*1024:
    raise ValueError('Image too large')
with Image.open(io.BytesIO(raw)) as im:
    if im.width*im.height>16_000_000:
        raise ValueError('Image too large')
    im.load()
    image=ImageOps.fit(im.convert('RGB'),(1200,630),method=Image.Resampling.LANCZOS)
    image.save(sys.stdout.buffer,format='JPEG',quality=90)
