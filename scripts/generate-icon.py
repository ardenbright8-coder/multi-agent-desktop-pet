from pathlib import Path
from PIL import Image, ImageDraw

out = Path("assets")
out.mkdir(parents=True, exist_ok=True)

size = 64
image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)

draw.rounded_rectangle((2, 2, 61, 61), radius=12, fill="#0f1c15")
draw.rectangle((29, 15, 34, 27), fill="#3f8d47")

# Pixel leaves
draw.polygon([(31, 18), (27, 18), (27, 16), (21, 16), (21, 14), (15, 14), (15, 16), (11, 16), (11, 20), (13, 20), (13, 23), (19, 23), (19, 25), (27, 25)], fill="#b9e86f")
draw.rectangle((16, 17, 19, 20), fill="#e4f7a0")
draw.line((18, 22, 29, 19), fill="#3f8d47", width=2)
draw.polygon([(33, 18), (37, 18), (37, 16), (43, 16), (43, 14), (49, 14), (49, 16), (53, 16), (53, 20), (51, 20), (51, 23), (45, 23), (45, 25), (37, 25)], fill="#b9e86f")
draw.rectangle((45, 17, 48, 20), fill="#e4f7a0")
draw.line((35, 19, 46, 22), fill="#3f8d47", width=2)

# Body, face, feet
draw.rectangle((20, 26, 44, 49), fill="#75c85d")
draw.rectangle((20, 45, 44, 49), fill="#3f8d47")
draw.rectangle((18, 31, 21, 42), fill="#3f8d47")
draw.rectangle((43, 31, 46, 42), fill="#3f8d47")
draw.rectangle((25, 32, 28, 36), fill="#f3f5e9")
draw.rectangle((26, 33, 28, 36), fill="#15241c")
draw.rectangle((36, 32, 39, 36), fill="#f3f5e9")
draw.rectangle((36, 33, 38, 36), fill="#15241c")
draw.rectangle((30, 40, 34, 42), fill="#15241c")
draw.rectangle((28, 51, 32, 54), fill="#285d38")
draw.rectangle((35, 51, 39, 54), fill="#285d38")
draw.rectangle((24, 55, 41, 57), fill="#f2c84b")

large = image.resize((256, 256), Image.Resampling.NEAREST)
large.save(out / "app-icon.png")
large.save(out / "app-icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("ICON_OK assets/app-icon.ico")
