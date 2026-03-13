"use strict"

const { execFile } = require("child_process")
const path = require("path")
const os   = require("os")

function buildFramedQr(upiLink, brandLabel = "") {
    const outFile = path.join(os.tmpdir(), `qr-${Date.now()}.png`)
    const label   = brandLabel.replace(/"/g, "")
    const script = `
import urllib.request, urllib.parse, io
from PIL import Image, ImageDraw, ImageFont
qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=" + urllib.parse.quote("${upiLink}") + "&qzone=2&color=1a1a2e&bgcolor=ffffff"
data = urllib.request.urlopen(qrUrl).read()
qr = Image.open(io.BytesIO(data)).convert("RGBA").resize((160,160), Image.LANCZOS)
pad,bar = 10,32
W,H = 160+pad*2, 160+pad*2+bar
out = Image.new("RGBA", (W,H), (255,255,255,255))
bar_img = Image.new("RGBA", (W,bar))
draw_bar = ImageDraw.Draw(bar_img)
for x in range(W):
  t=x/W; r=int(255*(1-t)+138*t); g=int(107*(1-t)+43*t); b=int(0*(1-t)+226*t)
  draw_bar.line([(x,0),(x,bar)],fill=(r,g,b,255))
out.paste(qr,(pad,pad))
out.paste(bar_img,(0,160+pad*2))
draw=ImageDraw.Draw(out)
try: font=ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc",13)
except: font=ImageFont.load_default()
label="${label}"
bbox=draw.textbbox((0,0),label,font=font)
draw.text(((W-(bbox[2]-bbox[0]))//2,160+pad*2+9),label,fill=(255,255,255,255),font=font)
mask=Image.new("L",(W,H),0)
ImageDraw.Draw(mask).rounded_rectangle([0,0,W-1,H-1],radius=12,fill=255)
out.putalpha(mask)
out.save("${outFile}")
`
    return new Promise((resolve, reject) => {
        execFile("python3", ["-c", script], (err) => {
            if (err) reject(err); else resolve(outFile)
        })
    })
}

module.exports = { buildFramedQr }
