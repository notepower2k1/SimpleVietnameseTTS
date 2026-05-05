from f5_tts.model.cfm import CFM

from f5_tts.model.backbones.unett import UNetT
from f5_tts.model.backbones.dit import DiT
from f5_tts.model.backbones.mmdit import MMDiT

# Keep infer imports lightweight: Trainer depends on optional train stack (wandb/accelerate).
__all__ = ["CFM", "UNetT", "DiT", "MMDiT", "Trainer"]


def __getattr__(name):
    if name == "Trainer":
        from f5_tts.model.trainer import Trainer

        return Trainer
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
