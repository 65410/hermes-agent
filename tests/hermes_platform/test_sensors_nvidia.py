"""NVIDIA sensor binding (pure) and a live read on a Windows/Linux host with NVML."""

from __future__ import annotations

import platform
import sys
import time

import pytest

from hermes_platform.sensors import nvidia
from hermes_platform.sensors.nvidia import open_sampler


def test_library_path_follows_the_os_convention_and_takes_no_env_input():
    if sys.platform == "win32":
        assert nvidia.nvml_library_path() == r"C:\Windows\System32\nvml.dll"
    elif sys.platform.startswith("linux"):
        assert nvidia.nvml_library_path() == "libnvidia-ml.so.1"
    else:
        assert nvidia.nvml_library_path() is None  # macOS: no NVML, nothing invented


def test_open_sampler_never_raises_off_nvidia_hosts(monkeypatch):
    monkeypatch.setattr(nvidia, "nvml_library_path", lambda: None)
    assert open_sampler() is None
    monkeypatch.setattr(nvidia, "nvml_library_path", lambda: r"C:\does\not\exist.dll")
    assert open_sampler() is None


def test_unreadable_values_read_back_none_not_zero():
    reading = nvidia.GpuReading(name="x", active=None, freq_mhz=None, cores=None, power_w=None,
                                power_limit_w=None, temp_c=None, mem_total=None, mem_used=None)
    assert reading.active is None and reading.freq_mhz is None and reading.cores is None
    assert reading.power_w is None and reading.temp_c is None


@pytest.mark.platforms("windows", "linux")
def test_live_sample_stays_within_the_hardware_envelope():
    sampler = open_sampler()
    if sampler is None:  # a host may have no NVIDIA driver; the null path is the contract
        pytest.skip("no NVML on this host")
    time.sleep(0.2)
    gpus = sampler.sample()
    assert gpus, "NVML initialized but reports no devices"
    for gpu in gpus:
        if gpu.active is not None:
            assert 0.0 <= gpu.active <= 1.0
        if gpu.temp_c is not None:
            assert 0 < gpu.temp_c < 150
        if gpu.power_w is not None:
            assert gpu.power_w >= 0
        if gpu.mem_total is not None and gpu.mem_used is not None:
            assert gpu.mem_used <= gpu.mem_total
