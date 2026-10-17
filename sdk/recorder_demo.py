"""Run after installation with: python sdk/recorder_demo.py"""

from flight_recorder import Recorder, record_step


@record_step("tool")
def greet(tool_name: str, name: str) -> dict[str, object]:
    return {"message": f"Hello, {name}!", "tokens_in": 3, "tokens_out": 2}


with Recorder("greeting", input={"name": "Ada"}) as recorder:
    recorder.output = greet("greet", "Ada")

print(recorder.to_dict())
