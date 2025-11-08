"""Setup script for trigger-sdk"""

from setuptools import setup, find_packages

setup(
    packages=find_packages(),
    package_data={
        "trigger_sdk": ["py.typed"],
    },
)
