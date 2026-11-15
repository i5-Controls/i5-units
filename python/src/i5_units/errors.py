"""Stable errors shared by the public API and bounded arithmetic."""


class UnitError(ValueError):
    """A unit operation failure with a stable cross-language error code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
