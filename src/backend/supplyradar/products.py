"""Product and supplier identity: turn printed names into stable keys."""
import re

_DECIMAL_COMMA = re.compile(r"(\d),(\d)")
_SPACES = re.compile(r"\s+")
_NOT_KEY = re.compile(r"[^0-9a-zа-я%.]+")


def normalize(name):
    """Lowercase, unify decimal commas, ё and whitespace: 'МОЛОКО 3,2  1Л' -> 'молоко 3.2 1л'."""
    text = (name or "").lower().replace("ё", "е")
    text = _DECIMAL_COMMA.sub(r"\1.\2", text)
    text = text.replace("«", "").replace("»", "").replace('"', "")
    return _SPACES.sub(" ", text).strip()


def product_key(canonical_name):
    """Key used in DynamoDB sort keys: 'молоко 3.2% 1 л' -> 'молоко-3.2pct-1-л'."""
    text = normalize(canonical_name).replace("%", "pct")
    key = _NOT_KEY.sub("-", text).strip("-.")
    return key[:100] or "unknown"


def supplier_key(supplier_bin, supplier_name, bin_ok):
    if bin_ok:
        return supplier_bin
    return product_key(supplier_name or "unknown")
