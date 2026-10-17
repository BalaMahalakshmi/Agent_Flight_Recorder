"""Fake customer database and tools for the demo agent."""

from typing import Any


_INITIAL_CUSTOMERS = (
    {"customer_id": "C101", "name": "Priya Sharma", "city": "Chennai", "status": "active"},
    {"customer_id": "C102", "name": "Priya Sharma", "city": "Chennai", "status": "duplicate"},
    {"customer_id": "C103", "name": "Arjun Rao", "city": "Bengaluru", "status": "active"},
)

CUSTOMERS: list[dict[str, str]] = [dict(customer) for customer in _INITIAL_CUSTOMERS]

TOOLS: list[dict[str, Any]] = [
    {
        "name": "find_customers",
        "description": "Find customers by name.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "The customer name to search for."}
            },
            "required": ["name"],
        },
    },
    {
        "name": "delete_customer",
        "description": "Delete a customer by customer ID.",
        "input_schema": {
            "type": "object",
            "properties": {
                "customer_id": {
                    "type": "string",
                    "description": "The ID of the customer to delete.",
                }
            },
            "required": ["customer_id"],
        },
    },
]


def reset_db() -> None:
    """Restore the in-memory database to its original three records."""
    CUSTOMERS[:] = [dict(customer) for customer in _INITIAL_CUSTOMERS]


def find_customers(name: str) -> dict[str, list[dict[str, str]]]:
    """Return all customers whose name matches the search text."""
    matches = [
        dict(customer)
        for customer in CUSTOMERS
        if name.casefold() in customer["name"].casefold()
    ]
    return {"customers": matches}


def delete_customer(customer_id: str) -> dict[str, Any]:
    """Delete one customer by ID, or report that the ID was not found."""
    for index, customer in enumerate(CUSTOMERS):
        if customer["customer_id"] == customer_id:
            deleted_customer = CUSTOMERS.pop(index)
            return {"deleted": True, "customer": dict(deleted_customer)}
    return {"deleted": False, "error": f"Customer {customer_id} was not found."}
