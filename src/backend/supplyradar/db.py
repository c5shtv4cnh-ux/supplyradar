"""DynamoDB access for the single-table design.

Every item belongs to one user (PK = USER#<cognito sub>). Sort keys:

    SETTINGS                                 alert threshold, email, SNS subscription
    INV#<invoice_id>                         invoice: status, fields, lines, issues
    DUP#<supplier_key>#<invoice_number>      first invoice seen with that number
    ALIAS#<normalized raw line name>         product key a printed name maps to
    PROD#<product_key>                       latest price per supplier
    PRICE#<product_key>#<date>#<inv>#<n>     one price observation (history)
    ALERT#<created_at>#<inv>#<product_key>   price increase above threshold

Handlers use the small Store interface below so tests can swap in an
in-memory implementation.
"""
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key

from . import config


def user_pk(user_id):
    return f"USER#{user_id}"


def to_db(value):
    """Convert floats (not allowed by boto3) to Decimal, recursively."""
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: to_db(v) for k, v in value.items()}
    if isinstance(value, list):
        return [to_db(v) for v in value]
    return value


def from_db(value):
    """Convert Decimals back to int/float so values are JSON-serialisable."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: from_db(v) for k, v in value.items()}
    if isinstance(value, list):
        return [from_db(v) for v in value]
    return value


class AlreadyExists(Exception):
    pass


class Store:
    def __init__(self, table):
        self._table = table

    def get(self, pk, sk):
        item = self._table.get_item(Key={"PK": pk, "SK": sk}).get("Item")
        return from_db(item) if item else None

    def put(self, item, if_absent=False):
        kwargs = {"Item": to_db(item)}
        if if_absent:
            kwargs["ConditionExpression"] = "attribute_not_exists(PK)"
        try:
            self._table.put_item(**kwargs)
        except self._table.meta.client.exceptions.ConditionalCheckFailedException:
            raise AlreadyExists(item["SK"])

    def query_prefix(self, pk, prefix, newest_first=False, limit=None):
        kwargs = {
            "KeyConditionExpression": Key("PK").eq(pk) & Key("SK").begins_with(prefix),
            "ScanIndexForward": not newest_first,
        }
        if limit:
            kwargs["Limit"] = limit
        return self._collect(self._table.query, kwargs, limit)

    def query_range(self, pk, start, end):
        kwargs = {"KeyConditionExpression": Key("PK").eq(pk) & Key("SK").between(start, end)}
        return self._collect(self._table.query, kwargs, None)

    def scan_sk(self, sk):
        kwargs = {
            "FilterExpression": "SK = :sk",
            "ExpressionAttributeValues": {":sk": sk},
        }
        return self._collect(self._table.scan, kwargs, None)

    @staticmethod
    def _collect(call, kwargs, limit):
        items = []
        while True:
            page = call(**kwargs)
            items.extend(from_db(i) for i in page.get("Items", []))
            last = page.get("LastEvaluatedKey")
            if not last or (limit and len(items) >= limit):
                return items[:limit] if limit else items
            kwargs["ExclusiveStartKey"] = last


_store = None


def store():
    global _store
    if _store is None:
        _store = Store(boto3.resource("dynamodb").Table(config.TABLE_NAME))
    return _store
