from dataclasses import dataclass
from pathlib import Path
import os


def _flag(name: str, default: bool = True) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


@dataclass(frozen=True)
class Settings:
    music_root: Path
    data_root: Path
    max_scan_tracks: int
    job_timeout_seconds: int
    scnet_enabled: bool
    bs_roformer_enabled: bool
    msst_root: Path
    scnet_config_url: str
    scnet_model_url: str
    gpu_lock_path: Path = Path("/tmp/grooveslate-gpu.lock")
    app_password: str = ""
    session_secret: str = ""
    media_extractor_enabled: bool = False
    max_import_bytes: int = 250 * 1024 * 1024
    max_import_duration_seconds: int = 15 * 60
    app_users: tuple[str, ...] = ("Pat", "Bob")
    app_admin_users: tuple[str, ...] = ("Pat",)
    library_cache_seconds: int = 300
    navidrome_db_path: Path | None = None
    youtube_only: bool = False

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            music_root=Path(os.getenv("MUSIC_ROOT", "/music")).resolve(),
            data_root=Path(os.getenv("DATA_ROOT", "/data")).resolve(),
            # Zero means unlimited. A music library should never silently disappear
            # from search merely because it grew past an arbitrary row count.
            max_scan_tracks=int(os.getenv("MAX_SCAN_TRACKS", "0")),
            job_timeout_seconds=int(os.getenv("JOB_TIMEOUT_SECONDS", "7200")),
            scnet_enabled=_flag("SCNET_ENABLED"),
            bs_roformer_enabled=_flag("BS_ROFORMER_ENABLED"),
            msst_root=Path(os.getenv("MSST_ROOT", "/opt/msst")).resolve(),
            scnet_config_url=os.getenv(
                "SCNET_CONFIG_URL",
                "https://github.com/ZFTurbo/Music-Source-Separation-Training/"
                "releases/download/v1.0.15/config_musdb18_scnet_xl_more_wide_v5.yaml",
            ),
            scnet_model_url=os.getenv(
                "SCNET_MODEL_URL",
                "https://github.com/ZFTurbo/Music-Source-Separation-Training/"
                "releases/download/v1.0.15/model_scnet_ep_36_sdr_10.0891.ckpt",
            ),
            gpu_lock_path=Path(
                os.getenv("GPU_LOCK_PATH", "/tmp/grooveslate-gpu.lock")
            ),
            app_password=os.getenv("APP_PASSWORD", ""),
            session_secret=os.getenv("APP_SESSION_SECRET", ""),
            media_extractor_enabled=_flag("MEDIA_EXTRACTOR_ENABLED", False),
            max_import_bytes=int(os.getenv("MAX_IMPORT_BYTES", str(250 * 1024 * 1024))),
            max_import_duration_seconds=int(
                os.getenv("MAX_IMPORT_DURATION_SECONDS", str(15 * 60))
            ),
            app_users=tuple(
                user.strip()
                for user in os.getenv("APP_USERS", "Pat,Bob").split(",")
                if user.strip()
            ),
            app_admin_users=tuple(
                user.strip()
                for user in os.getenv("APP_ADMIN_USERS", "Pat").split(",")
                if user.strip()
            ),
            library_cache_seconds=int(os.getenv("LIBRARY_CACHE_SECONDS", "300")),
            navidrome_db_path=(Path(value) if (value := os.getenv("NAVIDROME_DB_PATH", "")) else None),
            youtube_only=_flag("YOUTUBE_ONLY", False),
        )
