"""Opt-in one-shot validation. Never accepts a Key argument or environment Key."""
from __future__ import annotations
import argparse
import getpass
from pathlib import Path
import sys
import warnings

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--init", action="store_true")
    action.add_argument("--list", action="store_true")
    action.add_argument("--run", action="store_true")
    parser.add_argument("--pdf", type=Path)
    parser.add_argument("--original-page", type=int)
    parser.add_argument("--table")
    parser.add_argument("--model")
    parser.add_argument("--mode", choices=("Mock", "GeminiValidation"), default="Mock")
    args = parser.parse_args()
    from easyread import gemini_validation as validation
    try:
        if args.run and args.mode != "GeminiValidation":
            raise validation.ValidationError("--run requires --mode GeminiValidation")
        validation.configure(args.mode if args.run else "Mock")
        if args.init:
            validation.initialize()
            print("Inbox: " + str(validation.PROFILE / "inbox"))
            return 0
        if not args.pdf:
            raise validation.ValidationError("--pdf must name a single-page PDF in inbox")
        ws = validation.prepare(args.pdf, args.original_page)
        for table in validation.table_list(ws):
            print(f"{table['id']} | test PDF p.1 | {table['status']} | {table['caption']} | {table['reason']}")
        if not args.run:
            print("Local inspection only. No Key or model request.")
            return 0
        if not args.table or not args.model:
            raise validation.ValidationError("--run requires --table and --model")

        def confirm():
            print(f"Google Gemini model: {args.model}; test PDF p.1; selected table: {args.table}")
            print("At most one request. Existing Google project billing applies. No billing settings are changed.")
            return input("Type SEND to authorize this table only: ") == "SEND"

        def read_key():
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                return getpass.getpass("Gemini API Key (hidden, memory only): ")

        result = validation.execute(ws, args.table, args.model, confirm, read_key)
        print(f"paper={ws.id} table={args.table} translated={result['translated']} cached={result['cached']} HTTP attempts={result['http_attempts']}")
        print("Saved table: " + str(ws.paper_path))
        if result["failed"]:
            print("Validation stopped. The original table and PDF remain available; no retry.")
            for reason in result["failed"].values():
                print(reason)
            return 1
        print("Open results with start_table_review.ps1 -ReviewData GeminiValidation (Mock reader).")
        return 0
    except (validation.ValidationError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError, getpass.GetPassWarning):
        print("Cancelled or hidden input unavailable; no retry.", file=sys.stderr)
        return 1
    except Exception:
        print("Validation stopped safely. No retry; no credential details are logged.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
