from setuptools import setup, find_packages

setup(
    name="timelink-mvp",
    version="0.1.0",
    packages=find_packages(),
    install_requires=[
        "cryptography>=41.0.0",
        "Pillow>=10.0.0",
        "psutil>=5.9.0",
        "argparse>=1.4.0"
    ],
)
