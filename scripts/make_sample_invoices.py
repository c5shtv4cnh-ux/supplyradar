"""Generate synthetic supplier invoices (PNG) with ground-truth JSON.

All companies, BINs and prices are invented. Real invoices must not be sent to
the free Gemini tier (Google may use free-tier data to improve its models).

    python3 scripts/make_sample_invoices.py            # writes samples/
    python3 scripts/make_sample_invoices.py --out /tmp/x

Output:
    samples/eval/NN.png + NN.json   12 varied invoices for the accuracy test
    samples/demo/1-*.png ...        the scripted live-demo sequence
"""
import argparse
import json
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT_DIRS = ["/usr/share/fonts/truetype/dejavu", "/Library/Fonts", "C:/Windows/Fonts"]

SUPPLIERS = {
    "dairy": ("ТОО «Молочный двор»", "990140000017"),
    "farm": ("ТОО «Свежая ферма»", "050140001238"),
    "bakery": ("ИП «Хлебный дом»", "120340004562"),
    "fresh": ("ТОО «Зелёный рынок»", "980740007897"),
}

CATALOG = {
    "dairy": [
        ("Молоко 3,2% 1 л", "молоко 3.2% 1 л", "шт", 420),
        ("Сливки 33% 0,5 л", "сливки 33% 0.5 л", "шт", 1500),
        ("Масло сливочное 82% 200 г", "масло сливочное 82% 200 г", "шт", 1150),
        ("Творог 5% 1 кг", "творог 5% 1 кг", "кг", 1890),
        ("Сметана 20% 400 г", "сметана 20% 400 г", "шт", 690),
        ("Сыр Российский", "сыр российский", "кг", 4200),
    ],
    "farm": [
        ("МОЛОКО 3,2 1Л", "молоко 3.2% 1 л", "шт", 410),
        ("СЛИВКИ 33% 0,5Л", "сливки 33% 0.5 л", "шт", 1545),
        ("ЯЙЦО С1 10 ШТ", "яйца с1 10 шт", "уп", 780),
        ("КЕФИР 2,5% 1Л", "кефир 2.5% 1 л", "шт", 520),
    ],
    "bakery": [
        ("Хлеб белый нарезной", "хлеб белый нарезной", "шт", 230),
        ("Багет французский", "багет французский", "шт", 350),
        ("Круассан сливочный", "круассан сливочный", "шт", 290),
    ],
    "fresh": [
        ("Помидоры", "помидоры", "кг", 1100),
        ("Огурцы", "огурцы", "кг", 850),
        ("Лимоны", "лимоны", "кг", 1350),
        ("Мята свежая", "мята свежая", "пучок", 250),
    ],
}


def font(size, bold=False, mono=False):
    name = "DejaVuSansMono.ttf" if mono else ("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf")
    for d in FONT_DIRS:
        path = Path(d) / name
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def fmt(n):
    whole = f"{n:,.2f}".replace(",", " ").replace(".", ",")
    return whole


def render(inv, path, rng, style):
    W, H = 1240, 1754  # A4 at 150 dpi
    img = Image.new("RGB", (W, H), (252, 251, 247) if style != "white" else (255, 255, 255))
    d = ImageDraw.Draw(img)
    f_title, f_b, f, f_s = font(40, bold=True), font(26, bold=True), font(25), font(21)
    ink = (25, 25, 30)

    y = 80
    d.text((80, y), f"НАКЛАДНАЯ № {inv['invoice_number']}", font=f_title, fill=ink)
    dd, mm, yyyy = inv["invoice_date"][8:], inv["invoice_date"][5:7], inv["invoice_date"][:4]
    d.text((80, y + 60), f"от {dd}.{mm}.{yyyy} г.", font=f, fill=ink)
    y += 140
    d.text((80, y), f"Поставщик: {inv['supplier_name']}", font=f, fill=ink)
    d.text((80, y + 38), f"БИН: {inv['supplier_bin']}", font=f, fill=ink)
    d.text((80, y + 76), "Покупатель: ИП «Кофейня у парка» (пример)", font=f, fill=ink)
    y += 150

    cols = [80, 140, 640, 790, 890, 1060]
    heads = ["№", "Наименование", "Кол-во", "Ед.", "Цена", "Сумма"]
    d.rectangle([70, y - 10, 1170, y + 40], outline=ink, width=2)
    for x, h in zip(cols, heads):
        d.text((x, y), h, font=f_b, fill=ink)
    y += 50
    for i, line in enumerate(inv["lines"], 1):
        qty = f"{line['quantity']:g}".replace(".", ",")
        cells = [str(i), line["name"], qty, line["unit"], fmt(line["price"]), fmt(line["printed_total"])]
        for x, c in zip(cols, cells):
            d.text((x, y), c, font=f, fill=ink)
        d.line([70, y + 40, 1170, y + 40], fill=(160, 160, 160), width=1)
        y += 50
    y += 20
    d.text((760, y), f"Итого: {fmt(inv['printed_total'])} ₸", font=f_b, fill=ink)
    d.text((80, y + 60), "В т.ч. НДС не облагается", font=f_s, fill=(90, 90, 90))
    y += 160
    d.text((80, y), "Отпустил ____________        Получил ____________", font=f, fill=ink)
    if style in ("stamp", "photo"):
        cx, cy = 900, y + 30
        d.ellipse([cx - 90, cy - 90, cx + 90, cy + 90], outline=(40, 70, 170), width=4)
        d.text((cx - 62, cy - 14), "М.П. ТОО", font=f_s, fill=(40, 70, 170))

    if style == "photo":
        # Simulate a phone photo: slight rotation, warm tint, blur and noise.
        img = img.rotate(rng.uniform(-3, 3), resample=Image.BICUBIC, expand=True, fillcolor=(120, 110, 95))
        overlay = Image.new("RGB", img.size, (255, 236, 200))
        img = Image.blend(img, overlay, 0.12).filter(ImageFilter.GaussianBlur(0.8))
        px = img.load()
        for _ in range(25000):
            x, yy = rng.randrange(img.width), rng.randrange(img.height)
            v = rng.randrange(-35, 35)
            r, g, b = px[x, yy]
            px[x, yy] = (max(0, min(255, r + v)), max(0, min(255, g + v)), max(0, min(255, b + v)))
    img.save(path, optimize=True)


def make_invoice(supplier, number, date, items, overrides=None):
    name, bin_ = SUPPLIERS[supplier]
    lines = []
    for printed, canonical, unit, price, qty in items:
        lines.append({"name": printed, "canonical_name": canonical, "quantity": qty, "unit": unit,
                      "price": float(price), "total": round(price * qty, 2)})
    for line in lines:
        line["printed_total"] = line["total"]
    inv = {"supplier_name": name, "supplier_bin": bin_, "invoice_number": number, "invoice_date": date,
           "currency": "KZT", "lines": lines}
    inv["total"] = round(sum(l["total"] for l in lines), 2)
    inv["printed_total"] = inv["total"]
    if overrides:
        overrides(inv)
    return inv


def truth(inv):
    """Ground truth = what is printed (the model should copy, not correct)."""
    return {
        "supplier_name": inv["supplier_name"], "supplier_bin": inv["supplier_bin"],
        "invoice_number": inv["invoice_number"], "invoice_date": inv["invoice_date"],
        "currency": "KZT", "total": inv["printed_total"],
        "lines": [{"name": l["name"], "canonical_name": l["canonical_name"], "quantity": l["quantity"],
                   "unit": l["unit"], "price": l["price"], "total": l["printed_total"]} for l in inv["lines"]],
    }


def write(inv, path, rng, style):
    render(inv, path.with_suffix(".png"), rng, style)
    path.with_suffix(".json").write_text(json.dumps(truth(inv), ensure_ascii=False, indent=2))


def pick(rng, supplier, n, price_bump=0.0):
    rows = rng.sample(CATALOG[supplier], k=min(n, len(CATALOG[supplier])))
    return [(p, c, u, round(price * (1 + price_bump)), rng.choice([1, 2, 3, 5, 10])) for p, c, u, price in rows]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "samples"))
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    out = Path(args.out)
    (out / "eval").mkdir(parents=True, exist_ok=True)
    (out / "demo").mkdir(parents=True, exist_ok=True)

    styles = ["white", "stamp", "photo"]
    for i in range(12):
        supplier = list(SUPPLIERS)[i % 4]
        date = f"2026-{8 + i % 2:02d}-{rng.randint(1, 28):02d}"
        inv = make_invoice(supplier, str(2300 + i * 7), date, pick(rng, supplier, rng.randint(2, 5), rng.uniform(-.05, .15)))
        write(inv, out / "eval" / f"{i + 1:02d}", rng, styles[i % 3])

    # Demo sequence (see docs/demo-script.md):
    # 1. September invoice from the dairy: cream at 1500
    # 2. Other supplier, same products under different printed names: cream at 1545
    # 3. October invoice from the dairy: cream at 1680 (+12%) -> alert, cheaper at supplier 2
    # 4. Invoice with an arithmetic error -> needs review
    dairy = CATALOG["dairy"]
    farm = CATALOG["farm"]
    demo = [
        ("1-dairy-september", make_invoice("dairy", "2389", "2026-09-22", [
            (*dairy[0][:3], 420, 10), (*dairy[1][:3], 1500, 4), (*dairy[2][:3], 1150, 3)]), "white"),
        ("2-farm-october", make_invoice("farm", "117", "2026-10-03", [
            (*farm[0][:3], 410, 10), (*farm[1][:3], 1545, 4), (*farm[2][:3], 780, 2)]), "stamp"),
        ("3-dairy-october-price-up", make_invoice("dairy", "2417", "2026-10-12", [
            (*dairy[0][:3], 420, 10), (*dairy[1][:3], 1680, 4), (*dairy[2][:3], 1150, 3)]), "photo"),
    ]

    def wrong_row(inv):
        inv["lines"][1]["printed_total"] = 1860.0  # 6 x 290 is 1740, printed 1860
        inv["printed_total"] = round(sum(l["printed_total"] for l in inv["lines"]), 2)

    demo.append(("4-bakery-with-error", make_invoice("bakery", "55", "2026-10-14", [
        (*CATALOG["bakery"][0][:3], 230, 20), (*CATALOG["bakery"][2][:3], 290, 6)], wrong_row), "white"))

    for name, inv, style in demo:
        write(inv, out / "demo" / name, rng, style)
    print(f"wrote 12 eval and {len(demo)} demo invoices to {out}")


if __name__ == "__main__":
    main()
